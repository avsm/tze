/**
 * Region-wide cyberpunk satellite acquisition animation.
 *
 * Renders a single canvas covering the ROI polygon with:
 *   - Polygon-clipped dark overlay
 *   - Radar sweep beam rotating from centre
 *   - Horizontal scan line with glow
 *   - Tile grid cells that activate/pulse as chunks load
 *   - Data rain (falling hex characters) in unloaded areas
 *   - Particle field rising from loaded tiles
 *   - Edge glow on polygon border
 *   - HUD: progress ring, percentage, status text, coordinate readout
 */

export interface RegionAnimationOpts {
  map: maplibregl.Map;
  /** Polygon ring in [lng, lat] pairs (closed ring). */
  polygon: [number, number][];
  /** Bounding box [west, south, east, north] in lng/lat. */
  bbox: [number, number, number, number];
  /** Tile grid: which chunk indices are being loaded. */
  chunks: { ci: number; cj: number }[];
  /** Chunk grid bounds. */
  ciMin: number; ciMax: number; cjMin: number; cjMax: number;
  /** Function to get lng/lat corners for a chunk. */
  chunkCorners: (ci: number, cj: number) => [number, number][];
}

const SOURCE_ID = 'zarr-region-anim-src';
const LAYER_ID = 'zarr-region-anim-lyr';
const CANVAS_W = 1024;
const PUSH_INTERVAL = 60; // ms between MapLibre image updates

// Cyber colours
const CYAN = [0, 229, 255] as const;
const MAGENTA = [255, 0, 128] as const;
const AMBER = [255, 180, 0] as const;

export class RegionLoadingAnimation {
  private map: maplibregl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private corners: [[number, number], [number, number], [number, number], [number, number]];
  private frameId: number | null = null;
  private loaded = 0;
  private total: number;
  private startTime = performance.now();
  private lastPush = 0;
  private pendingUpdate = false;
  private destroyed = false;

  // Grid info
  private gridRows: number;
  private gridCols: number;
  private ciMin: number;
  private cjMin: number;
  private chunkSet: Set<string>;
  private loadedSet = new Set<string>();
  private tileActivateTime = new Map<string, number>(); // key → time when loaded

  // Polygon in canvas coordinates
  private polyPath: { x: number; y: number }[] = [];

  // Canvas dimensions
  private cw: number;
  private ch: number;

  // Particles
  private particles: { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number }[] = [];

  // Data rain columns
  private rainColumns: { chars: { char: string; y: number; speed: number; opacity: number }[] }[] = [];

  constructor(opts: RegionAnimationOpts) {
    this.map = opts.map;
    this.total = opts.chunks.length;
    this.ciMin = opts.ciMin;
    this.cjMin = opts.cjMin;
    this.gridRows = opts.ciMax - opts.ciMin + 1;
    this.gridCols = opts.cjMax - opts.cjMin + 1;

    this.chunkSet = new Set(opts.chunks.map(c => `${c.ci}_${c.cj}`));

    // Canvas aspect ratio from bbox
    const [west, south, east, north] = opts.bbox;
    const aspect = (east - west) / (north - south);
    this.cw = CANVAS_W;
    this.ch = Math.round(CANVAS_W / Math.max(0.1, aspect));
    if (this.ch < 100) this.ch = 100;
    if (this.ch > 2048) this.ch = 2048;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cw;
    this.canvas.height = this.ch;
    this.ctx = this.canvas.getContext('2d')!;

    // Corners for MapLibre ImageSource (TL, TR, BR, BL)
    this.corners = [
      [west, north], [east, north],
      [east, south], [west, south],
    ] as [[number, number], [number, number], [number, number], [number, number]];

    // Map polygon to canvas coordinates
    this.polyPath = opts.polygon.map(([lng, lat]) => ({
      x: ((lng - west) / (east - west)) * this.cw,
      y: ((north - lat) / (north - south)) * this.ch,
    }));

    // Initialize data rain
    this.initRain();

    // Add to map
    this.addToMap();
    this.animate(performance.now());
  }

  private initRain(): void {
    const cols = Math.ceil(this.cw / 14);
    const hexChars = '0123456789ABCDEF<>{}[]|/\\=+-*&%$#@!'.split('');
    for (let i = 0; i < cols; i++) {
      const numChars = 3 + Math.floor(Math.random() * 8);
      const chars = [];
      for (let j = 0; j < numChars; j++) {
        chars.push({
          char: hexChars[Math.floor(Math.random() * hexChars.length)],
          y: Math.random() * this.ch,
          speed: 30 + Math.random() * 80,
          opacity: 0.1 + Math.random() * 0.4,
        });
      }
      this.rainColumns.push({ chars });
    }
  }

  private addToMap(): void {
    // Render initial frame
    this.renderFrame(performance.now());
    const dataUrl = this.canvas.toDataURL('image/png');

    if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
    if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);

    this.map.addSource(SOURCE_ID, {
      type: 'image',
      url: dataUrl,
      coordinates: this.corners,
    });
    this.map.addLayer({
      id: LAYER_ID,
      type: 'raster',
      source: SOURCE_ID,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
    });
  }

  updateProgress(loaded: number, total: number): void {
    const prevLoaded = this.loaded;
    this.loaded = loaded;
    this.total = total;

    // Track newly loaded tiles
    if (loaded > prevLoaded) {
      // We don't know which specific tile loaded, but we'll update loadedSet from outside
    }
  }

  markTileLoaded(ci: number, cj: number): void {
    const key = `${ci}_${cj}`;
    if (!this.loadedSet.has(key)) {
      this.loadedSet.add(key);
      this.tileActivateTime.set(key, performance.now());
      // Spawn particles at tile centre
      this.spawnParticles(ci, cj);
    }
  }

  private spawnParticles(ci: number, cj: number): void {
    const col = cj - this.cjMin;
    const row = ci - this.ciMin;
    const cellW = this.cw / this.gridCols;
    const cellH = this.ch / this.gridRows;
    const cx = (col + 0.5) * cellW;
    const cy = (row + 0.5) * cellH;

    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 20 + Math.random() * 60;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * cellW * 0.5,
        y: cy + (Math.random() - 0.5) * cellH * 0.5,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 30,
        life: 0,
        maxLife: 0.8 + Math.random() * 1.2,
        size: 1 + Math.random() * 2,
      });
    }
  }

  private renderFrame(t: number): void {
    const ctx = this.ctx;
    const w = this.cw;
    const h = this.ch;
    const elapsed = (t - this.startTime) / 1000;
    const progress = this.total > 0 ? this.loaded / this.total : 0;
    const tau = Math.PI * 2;
    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    // --- Clip to polygon ---
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < this.polyPath.length; i++) {
      const p = this.polyPath[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.clip();

    // --- Dark background ---
    ctx.fillStyle = 'rgba(0, 4, 8, 0.85)';
    ctx.fillRect(0, 0, w, h);

    // --- Tile grid ---
    const cellW = w / this.gridCols;
    const cellH = h / this.gridRows;

    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        const ci = r + this.ciMin;
        const cj = c + this.cjMin;
        const key = `${ci}_${cj}`;
        if (!this.chunkSet.has(key)) continue;

        const x = c * cellW;
        const y = r * cellH;
        const isLoaded = this.loadedSet.has(key);
        const activateTime = this.tileActivateTime.get(key);

        if (isLoaded && activateTime) {
          // Loaded tile: glowing activation effect
          const since = (t - activateTime) / 1000;
          const flash = Math.max(0, 1 - since * 1.5); // bright flash fading over ~0.7s
          const pulse = 0.08 + 0.04 * Math.sin(elapsed * 3 + r * 0.5 + c * 0.7);

          // Fill with cyan glow
          ctx.fillStyle = `rgba(0, 229, 255, ${pulse + flash * 0.4})`;
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);

          // Bright border flash
          if (flash > 0) {
            ctx.strokeStyle = `rgba(255, 255, 255, ${flash * 0.8})`;
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
          }

          // Inner glow
          ctx.strokeStyle = `rgba(0, 229, 255, ${0.3 + pulse})`;
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
        } else {
          // Unloaded: dim cell with subtle pulse
          const dimPulse = 0.03 + 0.015 * Math.sin(elapsed * 2 + r * 1.1 + c * 0.9);
          ctx.fillStyle = `rgba(0, 180, 220, ${dimPulse})`;
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);

          // Grid lines
          ctx.strokeStyle = 'rgba(0, 229, 255, 0.06)';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x, y, cellW, cellH);
        }
      }
    }

    // --- Data rain in unloaded areas ---
    ctx.font = '10px monospace';
    const dt = 1 / 60;
    for (let i = 0; i < this.rainColumns.length; i++) {
      const col = this.rainColumns[i];
      const rx = i * 14 + 7;
      for (const ch of col.chars) {
        ch.y += ch.speed * dt;
        if (ch.y > h + 20) {
          ch.y = -10;
          ch.opacity = 0.1 + Math.random() * 0.35;
        }

        // Only draw in unloaded cells
        const gridCol = Math.floor(rx / cellW);
        const gridRow = Math.floor(ch.y / cellH);
        const ci = gridRow + this.ciMin;
        const cj = gridCol + this.cjMin;
        const key = `${ci}_${cj}`;
        if (this.loadedSet.has(key)) continue;

        const fade = ch.opacity * (1 - progress * 0.8);
        ctx.fillStyle = `rgba(0, 229, 255, ${fade})`;
        ctx.fillText(ch.char, rx, ch.y);
      }
    }

    // --- Radar sweep ---
    const sweepAngle = elapsed * 1.8; // ~1 rotation per 3.5s
    const sweepLen = Math.max(w, h) * 0.9;

    // Sweep beam (fading trail)
    for (let i = 0; i < 30; i++) {
      const a = sweepAngle - i * 0.02;
      const alpha = 0.15 * (1 - i / 30);
      ctx.strokeStyle = `rgba(0, 229, 255, ${alpha})`;
      ctx.lineWidth = 2 - i * 0.05;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * sweepLen, cy + Math.sin(a) * sweepLen);
      ctx.stroke();
    }

    // Bright tip
    const tipX = cx + Math.cos(sweepAngle) * sweepLen * 0.95;
    const tipY = cy + Math.sin(sweepAngle) * sweepLen * 0.95;
    const tipGlow = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, 20);
    tipGlow.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
    tipGlow.addColorStop(0.3, 'rgba(0, 229, 255, 0.3)');
    tipGlow.addColorStop(1, 'rgba(0, 229, 255, 0)');
    ctx.fillStyle = tipGlow;
    ctx.fillRect(tipX - 20, tipY - 20, 40, 40);

    // --- Horizontal scan line ---
    const scanY = ((elapsed * 60) % (h + 80)) - 40;
    const scanGrad = ctx.createLinearGradient(0, scanY - 30, 0, scanY + 30);
    scanGrad.addColorStop(0, 'rgba(0, 229, 255, 0)');
    scanGrad.addColorStop(0.4, 'rgba(0, 229, 255, 0.08)');
    scanGrad.addColorStop(0.5, 'rgba(0, 229, 255, 0.25)');
    scanGrad.addColorStop(0.6, 'rgba(0, 229, 255, 0.08)');
    scanGrad.addColorStop(1, 'rgba(0, 229, 255, 0)');
    ctx.fillStyle = scanGrad;
    ctx.fillRect(0, scanY - 30, w, 60);

    // Bright scanline
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, scanY);
    ctx.lineTo(w, scanY);
    ctx.stroke();

    // --- Particles ---
    const particleDt = dt;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += particleDt;
      if (p.life > p.maxLife) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * particleDt;
      p.y += p.vy * particleDt;
      p.vy -= 10 * particleDt; // float upward

      const lifeRatio = p.life / p.maxLife;
      const alpha = lifeRatio < 0.2
        ? lifeRatio / 0.2
        : 1 - (lifeRatio - 0.2) / 0.8;

      ctx.fillStyle = `rgba(0, 229, 255, ${alpha * 0.8})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 - lifeRatio * 0.5), 0, tau);
      ctx.fill();
    }

    // --- Polygon edge glow ---
    ctx.strokeStyle = `rgba(0, 229, 255, ${0.4 + 0.2 * Math.sin(elapsed * 3)})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.6)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let i = 0; i < this.polyPath.length; i++) {
      const p = this.polyPath[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // --- Corner brackets ---
    const bLen = Math.min(w, h) * 0.06;
    const bInset = 8;
    ctx.strokeStyle = `rgba(0, 229, 255, ${0.5 + 0.3 * Math.sin(elapsed * 2.5)})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.5)';
    ctx.shadowBlur = 6;
    // TL
    ctx.beginPath(); ctx.moveTo(bInset, bInset + bLen); ctx.lineTo(bInset, bInset); ctx.lineTo(bInset + bLen, bInset); ctx.stroke();
    // TR
    ctx.beginPath(); ctx.moveTo(w - bInset - bLen, bInset); ctx.lineTo(w - bInset, bInset); ctx.lineTo(w - bInset, bInset + bLen); ctx.stroke();
    // BL
    ctx.beginPath(); ctx.moveTo(bInset, h - bInset - bLen); ctx.lineTo(bInset, h - bInset); ctx.lineTo(bInset + bLen, h - bInset); ctx.stroke();
    // BR
    ctx.beginPath(); ctx.moveTo(w - bInset - bLen, h - bInset); ctx.lineTo(w - bInset, h - bInset); ctx.lineTo(w - bInset, h - bInset - bLen); ctx.stroke();
    ctx.shadowBlur = 0;

    // --- HUD centre: progress ring ---
    const ringR = Math.min(w, h) * 0.12;

    // Spinning outer ring
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.12)';
    ctx.lineWidth = 1;
    const spin1 = elapsed * 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR * 1.3, spin1, spin1 + tau * 0.65);
    ctx.stroke();

    // Counter-spin dashed
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = 'rgba(0, 180, 220, 0.1)';
    const spin2 = -elapsed * 0.8;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR * 1.5, spin2, spin2 + tau);
    ctx.stroke();
    ctx.setLineDash([]);

    // Tick marks
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * tau;
      const inner = ringR * 1.05;
      const outer = i % 12 === 0 ? ringR * 1.2 : ringR * 1.1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }

    // Progress arc
    const arcStart = -Math.PI / 2;
    const arcEnd = progress * tau;

    // Track
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.05)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, tau);
    ctx.stroke();

    if (progress > 0) {
      // Glow
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.15)';
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, arcStart, arcStart + arcEnd);
      ctx.stroke();

      // Main arc
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, arcStart, arcStart + arcEnd);
      ctx.stroke();
      ctx.lineCap = 'butt';

      // Arc tip glow
      if (progress < 1) {
        const tipA = arcStart + arcEnd;
        const tx2 = cx + Math.cos(tipA) * ringR;
        const ty2 = cy + Math.sin(tipA) * ringR;
        const tg = ctx.createRadialGradient(tx2, ty2, 0, tx2, ty2, 8);
        tg.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
        tg.addColorStop(0.4, 'rgba(0, 229, 255, 0.4)');
        tg.addColorStop(1, 'rgba(0, 229, 255, 0)');
        ctx.fillStyle = tg;
        ctx.fillRect(tx2 - 8, ty2 - 8, 16, 16);
      }
    }

    // Percentage
    const pct = Math.round(progress * 100);
    const fontSize = Math.max(14, Math.round(ringR * 0.7));
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 229, 255, 0.6)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = `rgba(0, 229, 255, ${0.85 + 0.15 * Math.sin(elapsed * 4)})`;
    ctx.fillText(`${pct}%`, cx, cy - fontSize * 0.15);
    ctx.shadowBlur = 0;

    // Sub-label
    const subSize = Math.max(8, Math.round(ringR * 0.22));
    ctx.font = `${subSize}px monospace`;
    ctx.fillStyle = `rgba(0, 229, 255, ${0.3 + 0.1 * Math.sin(elapsed * 2)})`;
    const labels = ['ACQUIRING', 'EMBEDDING', 'SCANNING', 'ANALYSING'];
    const labelIdx = Math.floor(elapsed / 2) % labels.length;
    ctx.fillText(labels[labelIdx], cx, cy + fontSize * 0.55);

    // Tile count
    const countSize = Math.max(7, Math.round(ringR * 0.18));
    ctx.font = `${countSize}px monospace`;
    ctx.fillStyle = 'rgba(0, 229, 255, 0.2)';
    ctx.fillText(`${this.loaded}/${this.total} TILES`, cx, cy + fontSize * 0.55 + countSize * 1.3);

    // --- Scanline noise overlay (subtle) ---
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let row = 0; row < h; row += 2) {
      const base = row * w * 4;
      for (let col = 0; col < w * 4; col += 4) {
        const idx = base + col;
        // Darken every other line slightly
        data[idx] = Math.round(data[idx] * 0.92);
        data[idx + 1] = Math.round(data[idx + 1] * 0.92);
        data[idx + 2] = Math.round(data[idx + 2] * 0.92);
      }
    }
    ctx.putImageData(imgData, 0, 0);

    ctx.restore(); // remove polygon clip
  }

  private animate = (t: number): void => {
    if (this.destroyed) return;
    this.renderFrame(t);

    if (t - this.lastPush >= PUSH_INTERVAL && !this.pendingUpdate) {
      this.pendingUpdate = true;
      this.lastPush = t;
      const url = this.canvas.toDataURL('image/png');
      const src = this.map.getSource(SOURCE_ID) as
        { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => unknown } | undefined;
      try {
        const result = src?.updateImage?.({ url, coordinates: this.corners });
        if (result && typeof (result as any).then === 'function') {
          (result as any).then(() => { this.pendingUpdate = false; }, () => { this.pendingUpdate = false; });
        } else {
          this.pendingUpdate = false;
        }
      } catch { this.pendingUpdate = false; }
    }

    this.frameId = requestAnimationFrame(this.animate);
  };

  destroy(): void {
    this.destroyed = true;
    if (this.frameId != null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    try {
      if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
    } catch { /* map may already be gone */ }
  }
}
