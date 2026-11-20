import { describe, expect, it, vi } from "vitest";
import { panView, zoomView } from "../shared/charts";
import { explorerTrackInputs, hasPublishedBands, type PublishedBands } from "./processed";
import { createCursorStore } from "./selection";
import { buildTracks } from "./tracks";

describe("strip zoom window", () => {
  it("zooms around a band, clamps to the axis and returns null at full width", () => {
    expect(zoomView(null, 100, 50, 0.5)).toEqual({ i0: 25, i1: 74 });
    expect(zoomView(null, 100, 0, 0.5)).toEqual({ i0: 0, i1: 49 });
    expect(zoomView(null, 100, 99, 0.5)).toEqual({ i0: 50, i1: 99 });
    expect(zoomView({ i0: 25, i1: 74 }, 100, 50, 2)).toBeNull();
    expect(zoomView({ i0: 10, i1: 13 }, 100, 11, 0.5)).toEqual({ i0: 10, i1: 13 });
  });
  it("pans without leaving the axis", () => {
    expect(panView({ i0: 10, i1: 19 }, 100, -30)).toEqual({ i0: 0, i1: 9 });
    expect(panView({ i0: 10, i1: 19 }, 100, 200)).toEqual({ i0: 90, i1: 99 });
    expect(panView(null, 100, 5)).toBeNull();
  });
});

describe("shared hover cursor store", () => {
  it("notifies only on change", () => {
    const store = createCursorStore();
    const l = vi.fn();
    const off = store.subscribe(l);
    store.set({ sourceId: "s", index: 3 });
    store.set({ sourceId: "s", index: 3 });
    store.set({ sourceId: "s", index: 4 });
    store.set(null);
    expect(l).toHaveBeenCalledTimes(3);
    off();
    store.set({ sourceId: "s", index: 1 });
    expect(l).toHaveBeenCalledTimes(3);
  });
});

describe("quality map on the explorer's spectra", () => {
  const axis = [1000, 1002, 1004, 1006];
  const diag = (scale: number) => ({ spikeBands: [0, 2, 0, 0], jumpBands: [0, 0, 0, 1], observations: 10, noiseProxy: [0.1 * scale, null, 0.2 * scale, 0.1 * scale], diversity: [1, 1, 0, 2], repeatabilitySd: null, icc: null });
  const profile: PublishedBands = { sourceId: "s", axis, label: "SG 11", n: 10, values: [0.01, 0.02, null, 0.01], bands: { raw: diag(1), processed: diag(0.5), preservesUnits: true } };

  it("requires the published bands on the same axis", () => {
    expect(hasPublishedBands(profile, axis)).toBe(true);
    expect(hasPublishedBands(profile, [1000, 1002, 1004])).toBe(false);
    expect(hasPublishedBands({ ...profile, bands: undefined }, axis)).toBe(false);
  });

  it("builds tracks from the processed diagnostics, with explicit denominators and no division by a zero diversity", () => {
    if (!hasPublishedBands(profile, axis)) throw new Error("unreachable");
    const tracks = buildTracks(explorerTrackInputs(profile, "processed", "abs"));
    const byId = Object.fromEntries(tracks.map((t) => [t.id, t]));
    expect(byId.noise_proxy!.values).toEqual([0.05, null, 0.1, 0.05]);
    expect(byId.noise_to_diversity!.values).toEqual([0.05, null, null, 0.025]);
    expect(byId.spike_frequency!.values).toEqual([0, 0.2, 0, 0]);
    expect(byId.spike_frequency!.provenance).toContain("explorer subset");
    expect(byId.icc!.unavailable).toContain("explorer subset");
    expect(byId.distortion!.unavailable).toBeNull();
    const raw = buildTracks(explorerTrackInputs(profile, "subset", "abs"));
    expect(raw.find((t) => t.id === "noise_proxy")!.values).toEqual([0.1, null, 0.2, 0.1]);
  });
});
