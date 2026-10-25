// Overview of the whole drawing with the current viewport; click or drag to pan.

export class Minimap {
  constructor(cy, root, theme) {
    this.cy = cy;
    this.root = root;
    this.theme = theme;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.layer = document.createElement('canvas'); // cached drawing of the nodes
    this.map = null;
    this.frame = 0;
    cy.on('viewport resize', () => this.schedule());
    const panTo = (e) => {
      if (!this.map) return;
      const r = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left - this.map.ox) / this.map.s + this.map.x1;
      const my = (e.clientY - r.top - this.map.oy) / this.map.s + this.map.y1;
      const z = this.cy.zoom();
      this.cy.pan({ x: this.cy.width() / 2 - mx * z, y: this.cy.height() / 2 - my * z });
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.dragging = true;
      panTo(e);
    });
    this.canvas.addEventListener('pointermove', (e) => this.dragging && panTo(e));
    this.canvas.addEventListener('pointerup', () => (this.dragging = false));
  }

  setTheme(theme) {
    this.theme = theme;
    this.refresh();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Re-draw the node layer (after layouts, filters, isolation). */
  refresh() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (!W || !H) return;
    for (const c of [this.canvas, this.layer]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
    // Class checks, not n.style(): style lookups on thousands of nodes are slow.
    const visible = this.cy.nodes().filter((n) => !n.hasClass('isolated-out') && !n.isParent() && !n.hasClass('lane') && !n.hasClass('group'));
    const lanes = this.cy.nodes('.lane');
    const all = visible.union(lanes);
    if (all.empty()) {
      this.map = null;
      this.draw();
      return;
    }
    const bb = all.boundingBox({ includeLabels: false });
    const pad = 8;
    const s = Math.min((W - pad * 2) / bb.w, (H - pad * 2) / bb.h);
    this.map = { x1: bb.x1, y1: bb.y1, s, ox: (W - bb.w * s) / 2, oy: (H - bb.h * s) / 2 };
    const ctx = this.layer.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const px = (x) => this.map.ox + (x - bb.x1) * s;
    const py = (y) => this.map.oy + (y - bb.y1) * s;
    lanes.forEach((n) => {
      const b = n.boundingBox({ includeLabels: false });
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = n.data('accent');
      ctx.fillRect(px(b.x1), py(b.y1), b.w * s, b.h * s);
    });
    ctx.globalAlpha = 0.85;
    visible.forEach((n) => {
      const p = n.position();
      const w = Math.max(1.5, n.data('w') * s);
      const h = Math.max(1.5, n.data('h') * s);
      ctx.globalAlpha = n.hasClass('faded') ? 0.25 : 0.9;
      ctx.fillStyle = n.data('accent') || this.theme.muted;
      ctx.fillRect(px(p.x) - w / 2, py(p.y) - h / 2, w, h);
    });
    ctx.globalAlpha = 1;
    this.draw();
  }

  /** Copy the node layer and draw the viewport rectangle on top. */
  draw() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.layer, 0, 0);
    if (!this.map) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ext = this.cy.extent();
    const { x1, y1, s, ox, oy } = this.map;
    const rx = ox + (ext.x1 - x1) * s;
    const ry = oy + (ext.y1 - y1) * s;
    ctx.fillStyle = this.theme.accent + '22';
    ctx.strokeStyle = this.theme.accent;
    ctx.lineWidth = 1.5;
    ctx.fillRect(rx, ry, ext.w * s, ext.h * s);
    ctx.strokeRect(rx, ry, ext.w * s, ext.h * s);
  }
}
