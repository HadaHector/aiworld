/** An RGBA image to show, and how to describe one of its pixels under the cursor. */
export interface TextureImage {
  width: number;
  height: number;
  /** RGBA, 8 bits a channel - what is drawn. */
  pixels: Uint8Array;
  /** Tiled n x n, so the seams and the repeat show; 1 for an atlas, which does not tile. */
  tiles: number;
  describe: (x: number, y: number) => string;
}

export interface TextureView {
  /** Shows an image. `keepView` keeps the zoom and position, for a re-bake of the same texture. */
  show: (image: TextureImage, keepView: boolean) => void;
  clear: () => void;
}

const MIN_SCALE = 1 / 16;
const MAX_SCALE = 64;

/**
 * A 2D texture on a canvas, zoomed with the wheel about the cursor, dragged to pan, and fitted to
 * the view with a double-click. Minified it is drawn smoothed; magnified, as crisp square pixels,
 * since that is when single texels are what is being looked at.
 */
export function createTextureView(canvas: HTMLCanvasElement, readout: HTMLElement): TextureView {
  const context = canvas.getContext("2d")!;
  let image: TextureImage | null = null;
  let bitmap: HTMLCanvasElement | null = null;
  // Screen position of the image's top-left corner, and screen pixels per texel - in CSS pixels.
  let offsetX = 0;
  let offsetY = 0;
  let scale = 1;

  function cssSize(): { width: number; height: number } {
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }

  function fit(): void {
    if (!image) return;
    const { width, height } = cssSize();
    const fullWidth = image.width * image.tiles;
    const fullHeight = image.height * image.tiles;
    scale = Math.min((width - 32) / fullWidth, (height - 32) / fullHeight);
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    offsetX = (width - fullWidth * scale) / 2;
    offsetY = (height - fullHeight * scale) / 2;
  }

  function draw(): void {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = cssSize();
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!image || !bitmap) return;
    context.setTransform(scale * ratio, 0, 0, scale * ratio, offsetX * ratio, offsetY * ratio);
    context.imageSmoothingEnabled = scale < 1;
    for (let ty = 0; ty < image.tiles; ty++) {
      for (let tx = 0; tx < image.tiles; tx++) context.drawImage(bitmap, tx * image.width, ty * image.height);
    }
  }

  new ResizeObserver(() => draw()).observe(canvas);

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (!image) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * Math.exp(-event.deltaY * 0.0015)));
      // Keep the texel under the cursor where it is.
      offsetX = x - ((x - offsetX) * next) / scale;
      offsetY = y - ((y - offsetY) * next) / scale;
      scale = next;
      draw();
    },
    { passive: false },
  );

  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX - offsetX, y: event.clientY - offsetY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointerup", (event) => {
    drag = null;
    canvas.releasePointerCapture(event.pointerId);
    canvas.classList.remove("dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drag) {
      offsetX = event.clientX - drag.x;
      offsetY = event.clientY - drag.y;
      draw();
    }
    if (!image) return;
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor((event.clientX - rect.left - offsetX) / scale);
    const ty = Math.floor((event.clientY - rect.top - offsetY) / scale);
    if (tx < 0 || ty < 0 || tx >= image.width * image.tiles || ty >= image.height * image.tiles) {
      readout.textContent = "";
      return;
    }
    const x = tx % image.width;
    const y = ty % image.height;
    readout.textContent = `${x}, ${y}   ${image.describe(x, y)}   ×${scale < 1 ? scale.toFixed(2) : scale.toFixed(1)}`;
  });
  canvas.addEventListener("pointerleave", () => {
    readout.textContent = "";
  });
  canvas.addEventListener("dblclick", () => {
    fit();
    draw();
  });

  return {
    show(next, keepView) {
      const sameSize = image !== null && image.width === next.width && image.height === next.height && image.tiles === next.tiles;
      image = next;
      bitmap = document.createElement("canvas");
      bitmap.width = next.width;
      bitmap.height = next.height;
      const data = new ImageData(new Uint8ClampedArray(next.pixels), next.width, next.height);
      bitmap.getContext("2d")!.putImageData(data, 0, 0);
      if (!keepView || !sameSize) fit();
      draw();
    },
    clear() {
      image = null;
      bitmap = null;
      readout.textContent = "";
      draw();
    },
  };
}
