// UMK3 Plus Online - minimal FBNeo frontend for WebAssembly.
//
// Exposes a small C ABI (core_*) around the FBNeo "burn" library. It replaces
// the desktop burner layer: ROMs come from memory buffers handed over by
// JavaScript (no filesystem), video is converted to RGBA8888 and audio is
// interleaved signed 16-bit stereo. Frame advance is fully driven by the caller,
// one core_run_frame() call per emulated frame.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "burnint.h"

#define CORE_API extern "C" EMSCRIPTEN_KEEPALIVE

// Logical button bits for each player. Mirrors shared/protocol/src/buttons.ts.
enum {
	BTN_UP = 0, BTN_DOWN, BTN_LEFT, BTN_RIGHT,
	BTN_FIRE1, BTN_FIRE2, BTN_FIRE3, BTN_FIRE4, BTN_FIRE5, BTN_FIRE6,
	BTN_START, BTN_COIN,
	BTN_COUNT
};

// System bits (cabinet switches, not tied to a player).
enum { SYS_SERVICE = 0, SYS_DIAG, SYS_TILT, SYS_RESET, SYS_COUNT };

static const char* const kPlayerInputInfo[BTN_COUNT] = {
	"up", "down", "left", "right",
	"fire 1", "fire 2", "fire 3", "fire 4", "fire 5", "fire 6",
	"start", "coin",
};

static const char* const kSystemInputInfo[SYS_COUNT] = { "service", "diag", "tilt", "reset" };

#define MAX_PLAYERS 2

struct RomBuffer {
	uint8_t* data;
	uint32_t len;
};

static bool g_libInit = false;
static bool g_drvInit = false;
static bool g_resetPending = false;
static const char* g_error = "";

static RomBuffer* g_roms = NULL;
static int g_romCount = 0;

static int g_width = 0;
static int g_height = 0;
static uint32_t* g_frame32 = NULL;   // FBNeo output, 0x00RRGGBB
static uint8_t* g_frameRgba = NULL;  // converted output, RGBA8888

static int16_t* g_audio = NULL;
static int g_audioCapacity = 0;      // in stereo frames

static UINT8* g_playerInputs[MAX_PLAYERS][BTN_COUNT];
static UINT8* g_systemInputs[SYS_COUNT];

static uint8_t* g_stateCursor = NULL;
static uint32_t g_stateBytes = 0;

static void SetError(const char* message)
{
	g_error = message;
}

static UINT32 __cdecl HighCol32(INT32 r, INT32 g, INT32 b, INT32 /*i*/)
{
	return ((UINT32)r << 16) | ((UINT32)g << 8) | (UINT32)b;
}

static INT32 __cdecl LoadRomFromMemory(UINT8* dest, INT32* wrote, INT32 i)
{
	if (i < 0 || i >= g_romCount || g_roms[i].data == NULL) {
		return 1;
	}

	struct BurnRomInfo ri;
	memset(&ri, 0, sizeof(ri));
	BurnDrvGetRomInfo(&ri, i);
	if (g_roms[i].len != ri.nLen) {
		return 1;
	}

	memcpy(dest, g_roms[i].data, g_roms[i].len);
	if (wrote) {
		*wrote = (INT32)g_roms[i].len;
	}
	return 0;
}

static void FreeRoms()
{
	for (int i = 0; i < g_romCount; i++) {
		free(g_roms[i].data);
	}
	free(g_roms);
	g_roms = NULL;
	g_romCount = 0;
}

static void FreeBuffers()
{
	free(g_frame32);
	free(g_frameRgba);
	free(g_audio);
	g_frame32 = NULL;
	g_frameRgba = NULL;
	g_audio = NULL;
	g_audioCapacity = 0;
	pBurnDraw = NULL;
	pBurnSoundOut = NULL;
}

// Same logic as the desktop burner's InpDIPSWResetDIPs(): every DIP entry with
// flags 0xFF holds the factory default for one DIP input.
static void ApplyDefaultDips()
{
	struct BurnDIPInfo bdi;
	INT32 offset = 0;
	for (INT32 i = 0; BurnDrvGetDIPInfo(&bdi, i) == 0; i++) {
		if (bdi.nFlags == 0xF0) {
			offset = bdi.nInput;
			break;
		}
	}

	for (INT32 i = 0; BurnDrvGetDIPInfo(&bdi, i) == 0; i++) {
		if (bdi.nFlags != 0xFF) {
			continue;
		}
		struct BurnInputInfo bii;
		if (BurnDrvGetInputInfo(&bii, bdi.nInput + offset) != 0 || bii.pVal == NULL) {
			continue;
		}
		*bii.pVal = (UINT8)((*bii.pVal & ~bdi.nMask) | (bdi.nSetting & bdi.nMask));
	}
}

// Resolves driver inputs by their szInfo name ("p1 up", "p2 fire 3", "service").
static void MapInputs()
{
	memset(g_playerInputs, 0, sizeof(g_playerInputs));
	memset(g_systemInputs, 0, sizeof(g_systemInputs));

	struct BurnInputInfo bii;
	for (UINT32 i = 0; BurnDrvGetInputInfo(&bii, i) == 0; i++) {
		if (bii.nType != BIT_DIGITAL || bii.szInfo == NULL || bii.pVal == NULL) {
			continue;
		}

		const char* info = bii.szInfo;
		if (info[0] == 'p' && info[1] >= '1' && info[1] < '1' + MAX_PLAYERS && info[2] == ' ') {
			int player = info[1] - '1';
			for (int b = 0; b < BTN_COUNT; b++) {
				if (strcmp(info + 3, kPlayerInputInfo[b]) == 0) {
					g_playerInputs[player][b] = bii.pVal;
				}
			}
			continue;
		}

		for (int s = 0; s < SYS_COUNT; s++) {
			if (strcmp(info, kSystemInputInfo[s]) == 0) {
				g_systemInputs[s] = bii.pVal;
			}
		}
	}
}

static INT32 __cdecl StateSizeAcb(struct BurnArea* pba)
{
	g_stateBytes += pba->nLen;
	return 0;
}

static INT32 __cdecl StateSaveAcb(struct BurnArea* pba)
{
	memcpy(g_stateCursor, pba->Data, pba->nLen);
	g_stateCursor += pba->nLen;
	return 0;
}

static INT32 __cdecl StateLoadAcb(struct BurnArea* pba)
{
	memcpy(pba->Data, g_stateCursor, pba->nLen);
	g_stateCursor += pba->nLen;
	return 0;
}

CORE_API const char* core_last_error()
{
	return g_error;
}

CORE_API int core_init()
{
	if (g_libInit) {
		return 0;
	}
	if (BurnLibInit() != 0) {
		SetError("BurnLibInit failed");
		return 1;
	}
	g_libInit = true;
	return 0;
}

CORE_API int core_driver_count()
{
	return (int)nBurnDrvCount;
}

// Selects a driver by its short name (e.g. "umk3p"). Returns 0 on success.
CORE_API int core_select_driver(const char* name)
{
	if (!g_libInit || g_drvInit) {
		SetError("core_select_driver: library not initialised or a game is running");
		return 1;
	}

	INT32 index = BurnDrvGetIndex((char*)name);
	if (index < 0) {
		SetError("core_select_driver: unknown driver");
		return 1;
	}
	nBurnDrvActive = (UINT32)index;

	FreeRoms();
	struct BurnRomInfo ri;
	while (BurnDrvGetRomInfo(&ri, g_romCount) == 0) {
		g_romCount++;
	}
	g_roms = (RomBuffer*)calloc(g_romCount > 0 ? g_romCount : 1, sizeof(RomBuffer));
	return 0;
}

CORE_API const char* core_driver_fullname()
{
	return BurnDrvGetTextA(DRV_FULLNAME);
}

CORE_API int core_rom_count()
{
	return g_romCount;
}

CORE_API const char* core_rom_name(int i)
{
	char* name = NULL;
	if (BurnDrvGetRomName(&name, i, 0) != 0) {
		return "";
	}
	return name;
}

CORE_API uint32_t core_rom_length(int i)
{
	struct BurnRomInfo ri;
	return BurnDrvGetRomInfo(&ri, i) == 0 ? ri.nLen : 0;
}

CORE_API uint32_t core_rom_crc(int i)
{
	struct BurnRomInfo ri;
	return BurnDrvGetRomInfo(&ri, i) == 0 ? ri.nCrc : 0;
}

CORE_API uint32_t core_rom_type(int i)
{
	struct BurnRomInfo ri;
	return BurnDrvGetRomInfo(&ri, i) == 0 ? ri.nType : 0;
}

// Takes ownership of a malloc()-allocated buffer holding ROM index i.
CORE_API int core_set_rom(int i, uint8_t* data, uint32_t len)
{
	if (i < 0 || i >= g_romCount) {
		free(data);
		SetError("core_set_rom: index out of range");
		return 1;
	}
	free(g_roms[i].data);
	g_roms[i].data = data;
	g_roms[i].len = len;
	return 0;
}

// Initialises the selected driver. The RNG seed and the emulated wall clock are
// fixed (see frontend_shims.cpp), so two instances started with the same ROMs
// and fed the same inputs produce the same frames.
CORE_API int core_start(int sampleRate)
{
	if (!g_libInit || g_drvInit || g_roms == NULL) {
		SetError("core_start: no driver selected or a game is already running");
		return 1;
	}

	BurnExtLoadRom = LoadRomFromMemory;
	BurnHighCol = HighCol32;
	nBurnBpp = 4;
	nBurnSoundRate = sampleRate;
	nBurnSoundLen = 0;
	pBurnSoundOut = NULL;
	nCurrentFrame = 0;

	ApplyDefaultDips();

	if (BurnDrvInit() != 0) {
		SetError("BurnDrvInit failed: missing or invalid ROM data");
		BurnDrvExit();
		return 1;
	}
	g_drvInit = true;

	// ROM contents now live in driver-owned memory.
	FreeRoms();

	BurnDrvGetVisibleSize(&g_width, &g_height);
	nBurnPitch = g_width * nBurnBpp;
	g_frame32 = (uint32_t*)calloc((size_t)g_width * g_height, 4);
	g_frameRgba = (uint8_t*)calloc((size_t)g_width * g_height, 4);

	// nBurnFPS is only known after the driver set its refresh rate.
	nBurnSoundLen = (sampleRate * 100 + nBurnFPS / 2) / nBurnFPS;
	g_audioCapacity = nBurnSoundLen;
	g_audio = (int16_t*)calloc((size_t)g_audioCapacity * 2, sizeof(int16_t));
	pBurnSoundOut = g_audio;

	if (g_frame32 == NULL || g_frameRgba == NULL || g_audio == NULL) {
		SetError("core_start: out of memory");
		return 1;
	}

	BurnRecalcPal();
	MapInputs();
	return 0;
}

CORE_API int core_width() { return g_width; }
CORE_API int core_height() { return g_height; }

// Frames per second multiplied by 100 (5471 for the Wolf-unit).
CORE_API int core_fps_x100() { return nBurnFPS; }

CORE_API int core_audio_frames_per_video_frame() { return nBurnSoundLen; }

CORE_API void core_set_input(int player, uint32_t buttons)
{
	if (player < 0 || player >= MAX_PLAYERS) {
		return;
	}
	for (int b = 0; b < BTN_COUNT; b++) {
		if (g_playerInputs[player][b]) {
			*g_playerInputs[player][b] = (buttons >> b) & 1;
		}
	}
}

CORE_API void core_set_system_input(uint32_t switches)
{
	for (int s = 0; s < SYS_COUNT; s++) {
		if (g_systemInputs[s]) {
			*g_systemInputs[s] = (switches >> s) & 1;
		}
	}
}

// Emulates one frame. When render is 0 the video output is skipped (the
// emulation itself is identical), which a future netcode can use to catch up.
CORE_API int core_run_frame(int render)
{
	if (!g_drvInit) {
		return 1;
	}

	pBurnDraw = render ? (UINT8*)g_frame32 : NULL;
	pBurnSoundOut = g_audio;
	if (g_resetPending) {
		*g_systemInputs[SYS_RESET] = 1;
	}
	nCurrentFrame++;
	BurnDrvFrame();
	if (g_resetPending) {
		*g_systemInputs[SYS_RESET] = 0;
		g_resetPending = false;
	}

	if (render) {
		const int pixels = g_width * g_height;
		for (int p = 0; p < pixels; p++) {
			const uint32_t c = g_frame32[p];
			uint8_t* out = g_frameRgba + p * 4;
			out[0] = (uint8_t)(c >> 16);
			out[1] = (uint8_t)(c >> 8);
			out[2] = (uint8_t)c;
			out[3] = 0xFF;
		}
	}
	return 0;
}

CORE_API uint8_t* core_video_buffer() { return g_frameRgba; }
CORE_API int16_t* core_audio_buffer() { return g_audio; }
CORE_API uint32_t core_frame_counter() { return nCurrentFrame; }

// FBNeo drivers reset when their "reset" input is held during a frame, so the
// request is applied on the next core_run_frame() call.
CORE_API int core_reset()
{
	if (!g_drvInit || g_systemInputs[SYS_RESET] == NULL) {
		SetError("core_reset: no game running or driver has no reset input");
		return 1;
	}
	g_resetPending = true;
	return 0;
}

CORE_API uint32_t core_state_size()
{
	if (!g_drvInit) {
		return 0;
	}
	g_stateBytes = 0;
	BurnAcb = StateSizeAcb;
	BurnAreaScan(ACB_FULLSCAN | ACB_READ, NULL);
	return g_stateBytes;
}

// Serialises the machine into dst (core_state_size() bytes). Returns 0 on success.
CORE_API int core_state_save(uint8_t* dst, uint32_t len)
{
	if (!g_drvInit || len != core_state_size()) {
		SetError("core_state_save: no game running or wrong buffer size");
		return 1;
	}
	g_stateCursor = dst;
	BurnAcb = StateSaveAcb;
	BurnAreaScan(ACB_FULLSCAN | ACB_READ, NULL);
	return 0;
}

CORE_API int core_state_load(const uint8_t* src, uint32_t len)
{
	if (!g_drvInit || len != core_state_size()) {
		SetError("core_state_load: no game running or state size mismatch");
		return 1;
	}
	g_stateCursor = (uint8_t*)src;
	BurnAcb = StateLoadAcb;
	BurnAreaScan(ACB_FULLSCAN | ACB_WRITE, NULL);
	return 0;
}

// Battery-backed RAM only (the UMK3 CMOS: operator settings, high scores).
// Unlike the full state, it survives a hardware reset.
CORE_API uint32_t core_nvram_size()
{
	if (!g_drvInit) {
		return 0;
	}
	g_stateBytes = 0;
	BurnAcb = StateSizeAcb;
	BurnAreaScan(ACB_NVRAM | ACB_READ, NULL);
	return g_stateBytes;
}

CORE_API int core_nvram_save(uint8_t* dst, uint32_t len)
{
	if (!g_drvInit || len != core_nvram_size()) {
		SetError("core_nvram_save: no game running or wrong buffer size");
		return 1;
	}
	g_stateCursor = dst;
	BurnAcb = StateSaveAcb;
	BurnAreaScan(ACB_NVRAM | ACB_READ, NULL);
	return 0;
}

// Replaces the battery-backed RAM, e.g. with a raw FBNeo/MAME NVRAM dump
// (umk3p.fs). Call before the game boots so it reads these settings.
CORE_API int core_nvram_load(const uint8_t* src, uint32_t len)
{
	if (!g_drvInit || len != core_nvram_size()) {
		SetError("core_nvram_load: no game running or NVRAM size mismatch");
		return 1;
	}
	g_stateCursor = (uint8_t*)src;
	BurnAcb = StateLoadAcb;
	BurnAreaScan(ACB_NVRAM | ACB_WRITE, NULL);
	return 0;
}

CORE_API void core_stop()
{
	if (g_drvInit) {
		BurnDrvExit();
		g_drvInit = false;
	}
	g_resetPending = false;
	FreeBuffers();
	FreeRoms();
}
