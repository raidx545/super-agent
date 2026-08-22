// ============================================================
// VLESS — Screenshot Capture
// Captures the visible viewport as a canvas for ONNX model processing
// All processing happens in-browser — no data leaves the device
// ============================================================

/**
 * Capture the current visible viewport as an HTMLCanvasElement.
 * This is the input for our on-device visual perception models.
 */
export async function captureViewport(): Promise<HTMLCanvasElement | null> {
  try {
    // Use Chrome's tabCapture API to get the visible tab
    const stream = await (chrome.tabCapture as any).capture({
      video: true,
      videoConstraints: {
        mandatory: {
          chromeMediaSource: "tab",
          maxWidth: 1920,
          maxHeight: 1080,
        },
      },
    });

    if (!stream) return null;

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;

    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => {
        video.play();
        // Wait a frame for the video to render
        requestAnimationFrame(() => resolve());
      };
    });

    // Create canvas and draw the video frame
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0);

    // Stop the stream
    if (stream) {
      (stream as MediaStream).getTracks().forEach((track: MediaStreamTrack) => track.stop());
    }
    video.srcObject = null;

    return canvas;
  } catch (error) {
    console.error("Screenshot capture failed:", error);
    return null;
  }
}

/**
 * Capture a specific element on the page as a canvas.
 */
export async function captureElement(
  element: Element
): Promise<HTMLCanvasElement | null> {
  try {
    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    const canvas = document.createElement("canvas");
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    // Use html2canvas-like approach: render element to canvas
    // For a production app, we'd use a proper library like html2canvas
    // For now, we use a simpler approach with SVG foreignObject

    // Use html2canvas-like approach: render element to canvas
    // For a production app, we'd use a proper library like html2canvas
    // For now, we use a simpler approach with SVG foreignObject

    const data = new XMLSerializer().serializeToString(
      createSVGForeignObject(element, rect)
    );

    const img = new Image();
    const blob = new Blob([data], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);

    return new Promise((resolve) => {
      img.onload = () => {
        ctx.drawImage(img, 0, 0, rect.width, rect.height);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  } catch (error) {
    console.error("Element capture failed:", error);
    return null;
  }
}

/**
 * Capture a region of the viewport defined by bounding box.
 */
export async function captureRegion(
  x: number,
  y: number,
  width: number,
  height: number
): Promise<HTMLCanvasElement | null> {
  const fullViewport = await captureViewport();
  if (!fullViewport) return null;

  const region = document.createElement("canvas");
  region.width = width;
  region.height = height;

  const ctx = region.getContext("2d")!;
  ctx.drawImage(
    fullViewport,
    x,
    y,
    width,
    height,
    0,
    0,
    width,
    height
  );

  return region;
}

function createSVGForeignObject(
  element: Element,
  rect: DOMRect
): SVGSVGElement {
  const svg = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg"
  );
  svg.setAttribute("width", String(rect.width));
  svg.setAttribute("height", String(rect.height));
  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

  const fo = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "foreignObject"
  );
  fo.setAttribute("width", "100%");
  fo.setAttribute("height", "100%");

  const clone = element.cloneNode(true) as Element;
  clone.setAttribute(
    "xmlns",
    "http://www.w3.org/1999/xhtml"
  );
  clone.setAttribute(
    "style",
    `margin: 0; padding: 0; width: ${rect.width}px; height: ${rect.height}px;`
  );

  // Inline all computed styles
  inlineStyles(element, clone);

  fo.appendChild(clone);
  svg.appendChild(fo);

  return svg;
}

function inlineStyles(source: Element, target: Element): void {
  const sourceStyles = window.getComputedStyle(source);
  let inlineCSS = "";

  for (let i = 0; i < sourceStyles.length; i++) {
    const prop = sourceStyles[i];
    inlineCSS += `${prop}: ${sourceStyles.getPropertyValue(prop)}; `;
  }

  target.setAttribute("style", inlineCSS);

  const sourceChildren = source.children;
  const targetChildren = target.children;

  for (let i = 0; i < sourceChildren.length; i++) {
    if (targetChildren[i]) {
      inlineStyles(sourceChildren[i], targetChildren[i]);
    }
  }
}
