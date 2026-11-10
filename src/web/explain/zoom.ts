// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The zoom of the diagram dialog. A scale of 1 shows the SVG at its own pixel size.
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.25;

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

// The scale that shows the whole image in the box. An unknown size gives 1.
export function fitZoom(image: { w: number; h: number }, box: { w: number; h: number }): number {
  if (image.w <= 0 || image.h <= 0 || box.w <= 0 || box.h <= 0) return 1;
  return clampZoom(Math.min(box.w / image.w, box.h / image.h));
}

// Rounds to 4 digits, so that 1.25 steps in and out come back to the same scale.
const round = (z: number) => Math.round(z * 1e4) / 1e4;
export const zoomIn = (z: number) => clampZoom(round(z * ZOOM_STEP));
export const zoomOut = (z: number) => clampZoom(round(z / ZOOM_STEP));
export const zoomPercent = (z: number) => `${Math.round(z * 100)}%`;
