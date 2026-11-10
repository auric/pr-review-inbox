// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The zoom of the diagram dialog: the fit scale, the steps, and the limits.
import { expect, test } from "bun:test";
import { clampZoom, fitZoom, ZOOM_MAX, ZOOM_MIN, zoomIn, zoomOut, zoomPercent } from "../../src/web/explain/zoom";

test("fit shows the whole image: the tighter side sets the scale, up or down, inside the limits", () => {
  console.log(`zoom tests import ${Bun.resolveSync("../../src/web/explain/zoom", import.meta.dir)}`);
  expect(fitZoom({ w: 2000, h: 500 }, { w: 1000, h: 800 })).toBe(0.5);
  expect(fitZoom({ w: 400, h: 1000 }, { w: 1000, h: 500 })).toBe(0.5);
  expect(fitZoom({ w: 200, h: 100 }, { w: 1000, h: 800 })).toBe(5);
  expect(fitZoom({ w: 10, h: 10 }, { w: 1000, h: 1000 })).toBe(ZOOM_MAX);
  expect(fitZoom({ w: 100_000, h: 10 }, { w: 100, h: 100 })).toBe(ZOOM_MIN);
  // An image or a box without a size yet gives 100%.
  expect(fitZoom({ w: 0, h: 0 }, { w: 1000, h: 800 })).toBe(1);
  expect(fitZoom({ w: 200, h: 100 }, { w: 0, h: 0 })).toBe(1);
});

test("the steps go by 1.25, come back to the same scale, and stop at the limits", () => {
  expect(zoomIn(1)).toBe(1.25);
  expect(zoomOut(1)).toBe(0.8);
  expect(zoomOut(zoomIn(1))).toBe(1);
  expect(zoomIn(zoomOut(zoomOut(1)))).toBe(0.8);
  expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
  expect(zoomIn(7)).toBe(ZOOM_MAX);
  expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  expect(zoomOut(0.11)).toBe(ZOOM_MIN);
  expect(clampZoom(-1)).toBe(ZOOM_MIN);
  expect(clampZoom(100)).toBe(ZOOM_MAX);
});

test("the zoom shows in whole percent", () => {
  expect(zoomPercent(1)).toBe("100%");
  expect(zoomPercent(0.8)).toBe("80%");
  expect(zoomPercent(1 / 3)).toBe("33%");
  expect(zoomPercent(ZOOM_MAX)).toBe("800%");
});
