// Symbols that FBNeo's burn library expects the desktop frontend ("burner") to
// provide. The WASM build does not link the burner layer, so the subsystems
// behind these symbols (input recording/replay, rewind, on-screen messages) do
// not exist here. Each definition below reports "feature not active" instead of
// pretending to implement it.

#include "burnint.h"

// Always report "netgame" mode. burn.cpp then seeds BurnRandom() with a fixed
// value and BurnGetLocalTime() returns a fixed date instead of time(NULL); the
// Wolf-unit protection PIC (midwayic.cpp) consumes BurnRandom(), so this is
// required for two browser instances to stay in lockstep.
INT32 is_netgame_or_recording()
{
	return 1;
}

// "RomData" (.dat-described ROM sets) is a burner feature. Same defaults as the
// SDL frontend's romdata.cpp: an empty descriptor and no data-ROM list.
static struct RomDataInfo g_romDataInfo = { 0 };
RomDataInfo* pRDI = &g_romDataInfo;
struct BurnRomInfo* pDataRomDesc = NULL;

// FBNeo's built-in IPS loader is disabled: bDoIpsPatch stays false, so load.cpp
// never calls IpsApplyPatches(). UMK3 Plus patches are applied by the web app
// before the ROMs reach the core (apps/web/src/game/rom/ips.ts).
bool bDoIpsPatch = false;
UINT32 nIpsMemExpLen[SND2_ROM + 1] = { 0 };
void IpsApplyPatches(UINT8* /*base*/, char* /*rom_name*/, UINT32 /*rom_crc*/, bool /*readonly*/)
{
}

// Hiscore saving is never enabled (EnableHiscores stays 0); the path is unused.
TCHAR szAppHiscorePath[MAX_PATH] = _T("");

// Only used to scale mouse input, which this frontend does not provide.
INT32 nInputIntfMouseDivider = 1;
