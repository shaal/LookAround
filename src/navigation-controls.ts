interface Navigation {
  drag(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  zoom(amount: number): void;
}
type Action = "orbit" | "pan" | "zoom";

/** OrbitControls mouse convention, shared by all tracking modes. */
export function navigationAction(
  button: number,
  modified: boolean,
): Action | null {
  if (button === 0) return modified ? "pan" : "orbit";
  if (button === 1) return "zoom";
  if (button === 2) return "pan";
  return null;
}

export class NavigationControls {
  private pointer: { id: number; button: number; x: number; y: number } | null =
    null;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  private manual = false;

  constructor(
    private canvas: HTMLElement,
    private navigation: Navigation,
    private onManual: (active: boolean) => void,
  ) {
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      if (this.pointer || !navigationAction(event.button, false)) return;
      event.preventDefault();
      this.pointer = {
        id: event.pointerId,
        button: event.button,
        x: event.clientX,
        y: event.clientY,
      };
      canvas.dataset.navigation = navigationAction(
        event.button,
        event.shiftKey || event.ctrlKey || event.metaKey,
      )!;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      this.syncManual();
    });
    canvas.addEventListener("pointermove", (event) => {
      const p = this.pointer;
      if (!p || p.id !== event.pointerId) return;
      const dx = event.clientX - p.x,
        dy = event.clientY - p.y;
      p.x = event.clientX;
      p.y = event.clientY;
      const action = navigationAction(
        p.button,
        event.shiftKey || event.ctrlKey || event.metaKey,
      );
      canvas.dataset.navigation = action!;
      if (action === "orbit") navigation.drag(dx, dy);
      else if (action === "pan") navigation.pan(dx, dy);
      else navigation.zoom(dy * 5);
    });
    const release = (event: PointerEvent) => {
      if (this.pointer?.id !== event.pointerId) return;
      this.releasePointer();
      this.syncManual();
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("lostpointercapture", release);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const unit =
          event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? canvas.clientHeight
              : 1;
        const amount = event.deltaY * unit * (event.ctrlKey ? 8 : 1);
        if (!Number.isFinite(amount) || !amount) return;
        if (this.wheelTimer !== null) clearTimeout(this.wheelTimer);
        this.wheelTimer = setTimeout(() => {
          this.wheelTimer = null;
          this.syncManual();
        }, 200);
        this.syncManual();
        navigation.zoom(amount);
      },
      { passive: false },
    );
    window.addEventListener("blur", () => this.cancel());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancel();
    });
  }

  private releasePointer() {
    const id = this.pointer?.id;
    this.pointer = null;
    delete this.canvas.dataset.navigation;
    if (id !== undefined && this.canvas.hasPointerCapture(id))
      this.canvas.releasePointerCapture(id);
  }

  private cancel() {
    this.releasePointer();
    if (this.wheelTimer !== null) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.syncManual();
  }

  private syncManual() {
    const active = this.pointer !== null || this.wheelTimer !== null;
    if (active === this.manual) return;
    this.manual = active;
    this.onManual(active);
  }
}
