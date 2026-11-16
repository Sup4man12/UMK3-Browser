import { Button } from "@umk3/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, InputManager, rebind } from "./InputManager";

function setup() {
  const changes: number[] = [];
  const manager = new InputManager(DEFAULT_BINDINGS, (b) => changes.push(b));
  return { manager, changes };
}

describe("InputManager", () => {
  it("builds the local player's mask and reports only changes", () => {
    const { manager, changes } = setup();
    expect(manager.handleKey("KeyA", true)).toBe(true);
    expect(manager.handleKey("KeyU", true)).toBe(true);
    manager.handleKey("KeyU", true); // auto-repeat: no new event
    manager.handleKey("KeyA", false);
    expect(changes).toEqual([Button.Left, Button.Left | Button.Fire1, Button.Fire1]);
  });

  it("has no second-player keys and never binds reserved keys", () => {
    const { manager, changes } = setup();
    expect(manager.handleKey("ArrowLeft", true)).toBe(false);
    expect(manager.handleKey("Numpad7", true)).toBe(false);
    expect(manager.handleKey("Enter", true)).toBe(false);
    expect(changes).toEqual([]);

    manager.setBindings({ Start: "Enter" });
    expect(manager.handleKey("Enter", true)).toBe(false);
  });

  it("releases everything (e.g. on window blur)", () => {
    const { manager, changes } = setup();
    manager.handleKey("KeyW", true);
    manager.releaseAll();
    expect(changes).toEqual([Button.Up, 0]);
  });

  it("rebind moves a key, never leaves it bound twice and refuses reserved keys", () => {
    const next = rebind(DEFAULT_BINDINGS, "Fire2", "KeyU");
    expect(next.Fire2).toBe("KeyU");
    expect(next.Fire1).toBeUndefined();
    expect(DEFAULT_BINDINGS.Fire1).toBe("KeyU");
    expect(rebind(DEFAULT_BINDINGS, "Start", "Enter")).toBe(DEFAULT_BINDINGS);
  });
});
