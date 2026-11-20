// stage.js: the live canvas. Renders the director "on twos" (12 drawings a second, like
// hand-drawn animation) at logical resolution, then scales up with nearest neighbour at an
// integer number of device pixels per art pixel, so edges stay crisp at any Windows scaling.

window.Clawd = window.Clawd || {};
(function (C) {
    "use strict";

    const FPS = 12;

    class Stage {
        constructor(canvas, { scale = 4, w = 80, h = 64, gx = 40, gy = 57, director } = {}) {
            this.canvas = canvas;
            this.w = w; this.h = h; this.gx = gx; this.gy = gy;
            this.frame = new C.Frame(w, h);
            this.director = director || new C.Director();
            this.buf = document.createElement("canvas");
            this.buf.width = w; this.buf.height = h;
            this.bufCtx = this.buf.getContext("2d");
            this.image = this.bufCtx.createImageData(w, h);
            this.image32 = new Uint32Array(this.image.data.buffer);
            this.lastDrawing = -1;
            this.info = null;
            this.box = null;          // Clawd's bounding box, CSS px relative to the canvas
            this.running = false;
            this.setScale(scale);
            this.watchDpr();
        }

        // Dragged onto a monitor with another scaling factor: re-derive the device pixels per art
        // pixel so edges stay crisp (the media query only fires once, so re-arm it each time).
        watchDpr() {
            window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
                .addEventListener("change", () => { this.setScale(this.scale); this.watchDpr(); }, { once: true });
        }

        setScale(scale) {
            this.scale = scale;
            const dpr = window.devicePixelRatio || 1;
            this.px = Math.max(1, Math.round(scale * dpr));      // device pixels per art pixel
            this.canvas.width = this.w * this.px;
            this.canvas.height = this.h * this.px;
            this.canvas.style.width = `${(this.w * this.px) / dpr}px`;
            this.canvas.style.height = `${(this.h * this.px) / dpr}px`;
            this.ctx = this.canvas.getContext("2d");
            this.ctx.imageSmoothingEnabled = false;
            this.cssPx = this.px / dpr;                          // CSS px per art pixel
            this.lastDrawing = -1;
            this.onScale?.();
        }

        now() { return performance.now() / 1000; }

        // A timer aligned to the drawing boundaries: 12 wake-ups a second rather than the
        // display's 60-144 — Clawd sits beside the writer all day.
        start() {
            if (this.running) return;
            this.running = true;
            const tick = () => {
                if (!this.running) return;
                const n = Math.floor(this.now() * FPS);
                try {
                    if (n !== this.lastDrawing) {
                        this.lastDrawing = n;
                        this.draw(n / FPS);
                    }
                } catch (err) {
                    console.error("clawd frame failed", err);   // skip a frame, never freeze
                } finally {
                    const next = (n + 1) / FPS - this.now();
                    setTimeout(tick, Math.max(4, next * 1000 + 1));
                }
            };
            tick();
        }
        stop() { this.running = false; }

        draw(t) {
            this.frame.clear();
            this.info = this.director.render(this.frame, this.gx, this.gy, t);
            this.image32.set(this.frame.data);
            this.bufCtx.putImageData(this.image, 0, 0);
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.drawImage(this.buf, 0, 0, this.canvas.width, this.canvas.height);
            const b = this.info && this.info.box;   // the body only: emotes don't make Clawd bigger to grab
            this.box = b ? { x: b.x * this.cssPx, y: b.y * this.cssPx, w: b.w * this.cssPx, h: b.h * this.cssPx } : null;
            this.onDraw?.(t, this.info);
        }

        // Is a point (client coordinates) on Clawd? A few pixels of slack make Clawd easy to grab.
        hit(clientX, clientY, slack = 6) {
            if (!this.box) return false;
            const r = this.canvas.getBoundingClientRect();
            const x = clientX - r.left, y = clientY - r.top, b = this.box;
            return x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack;
        }

        // Where a point is relative to the resting eyes, in art pixels (for the gaze).
        toArt(clientX, clientY) {
            const r = this.canvas.getBoundingClientRect();
            return { x: (clientX - r.left) / this.cssPx - this.gx, y: (clientY - r.top) / this.cssPx - (this.gy + C.mascot.eyeY) };
        }

        // The resting head position in client coordinates (bubble tail, badge).
        anchor() {
            const r = this.canvas.getBoundingClientRect(), m = C.mascot;
            return {
                x: r.left + this.gx * this.cssPx,
                headTop: r.top + (this.gy + m.top - 1) * this.cssPx,
                left: r.left + (this.gx - m.halfWidth) * this.cssPx,
                right: r.left + (this.gx + m.halfWidth) * this.cssPx,
            };
        }
    }

    Object.assign(C, { Stage, FPS });
})(window.Clawd);
