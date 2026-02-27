const VERT = `#version 300 es
uniform mat4 uMVP;
uniform float uPointSize;
in vec3 aPosition;
in vec4 aColor;
out vec4 vColor;
void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  gl_PointSize = uPointSize;
  vColor = aColor;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  fragColor = vColor;
}`;

function createShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, createShader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, createShader(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  return p;
}

/** 4×4 perspective matrix (column-major). */
function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

/** 4×4 Y-rotation matrix (column-major). */
function rotateY(angle: number): Float32Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // prettier-ignore
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ]);
}

/** 4×4 X-rotation matrix (column-major). */
function rotateX(angle: number): Float32Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // prettier-ignore
  return new Float32Array([
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1,
  ]);
}

/** 4×4 translation matrix (column-major). */
function translate(x: number, y: number, z: number): Float32Array {
  // prettier-ignore
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

/** Multiply two 4×4 column-major matrices: out = a * b. */
function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      o[j * 4 + i] =
        a[0 * 4 + i] * b[j * 4 + 0] +
        a[1 * 4 + i] * b[j * 4 + 1] +
        a[2 * 4 + i] * b[j * 4 + 2] +
        a[3 * 4 + i] * b[j * 4 + 3];
    }
  }
  return o;
}

export class PointCloudRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private colBuf: WebGLBuffer;
  private uMVP: WebGLUniformLocation;
  private uPointSize: WebGLUniformLocation;
  private count = 0;
  private refIndex = -1;
  private angleY = 0;
  private angleX = 0;
  private animId = 0;
  private lastTime = 0;
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragBaseY = 0;
  private dragBaseX = 0;
  private autoSpin = true;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })!;
    this.gl = gl;

    this.program = createProgram(gl);
    gl.useProgram(this.program);

    this.uMVP = gl.getUniformLocation(this.program, 'uMVP')!;
    this.uPointSize = gl.getUniformLocation(this.program, 'uPointSize')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    const aPos = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

    this.colBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    const aCol = gl.getAttribLocation(this.program, 'aColor');
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.07, 0.07, 0.10, 1.0);

    // Mouse interaction
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('mouseleave', this.onMouseUp);
  }

  private onMouseDown = (e: MouseEvent) => {
    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragBaseY = this.angleY;
    this.dragBaseX = this.angleX;
    this.autoSpin = false;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    this.angleY = this.dragBaseY + dx * 0.01;
    this.angleX = this.dragBaseX + dy * 0.01;
  };

  private onMouseUp = () => {
    if (this.dragging) {
      this.dragging = false;
      this.autoSpin = true;
      this.lastTime = performance.now();
    }
  };

  setData(positions: Float32Array, colors: Uint8Array, refIndex: number) {
    const { gl } = this;
    this.count = positions.length / 3;
    this.refIndex = refIndex;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  }

  updateColors(colors: Uint8Array) {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
  }

  start() {
    cancelAnimationFrame(this.animId);
    this.lastTime = performance.now();
    this.angleY = 0;
    this.angleX = -0.3;
    this.autoSpin = true;
    const loop = (now: number) => {
      if (this.disposed) return;
      if (this.autoSpin) {
        const dt = (now - this.lastTime) / 1000;
        this.angleY += dt * (Math.PI / 10); // ~18°/s
      }
      this.lastTime = now;
      this.draw();
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  private draw() {
    const { gl, canvas } = this;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.count === 0) return;

    const aspect = canvas.width / canvas.height;
    const proj = perspective(Math.PI / 4, aspect, 0.1, 100);
    const view = translate(0, 0, -2.5);
    const model = mul4(rotateY(this.angleY), rotateX(this.angleX));
    const mvp = mul4(proj, mul4(view, model));

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.uMVP, false, mvp);

    // Draw normal points
    gl.uniform1f(this.uPointSize, 2.0 * (canvas.width / 400));
    gl.drawArrays(gl.POINTS, 0, this.count);

    // Draw reference pixel larger on top
    if (this.refIndex >= 0 && this.refIndex < this.count) {
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1f(this.uPointSize, 6.0 * (canvas.width / 400));
      gl.drawArrays(gl.POINTS, this.refIndex, 1);
      gl.enable(gl.DEPTH_TEST);
    }

    gl.bindVertexArray(null);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.animId);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('mouseleave', this.onMouseUp);
    const { gl } = this;
    gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.colBuf);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
