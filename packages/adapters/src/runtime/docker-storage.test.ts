import { describe, expect, it } from "vitest";
import { dockerProjectStorage } from "./docker-storage";

const projects = [
  { id: "a", slug: "app" },
  { id: "b", slug: "app-db" },
];
describe("workspace disk accounting", () => {
  it("counts writable layers and volumes once, leaving shared images/cache outside project usage", () => {
    const result = dockerProjectStorage(
      {
        Containers: [
          {
            Labels: { "openship.project": "a" },
            SizeRw: 10,
            Mounts: [{ Type: "volume", Name: "data" }],
          },
          {
            Labels: { "openship.project": "a" },
            SizeRw: 20,
            Mounts: [
              { Type: "volume", Name: "data" },
              { Type: "volume", Name: "shared" },
            ],
          },
          {
            Labels: { "openship.project": "b" },
            SizeRw: 5,
            Mounts: [{ Type: "volume", Name: "shared" }],
          },
        ],
        Volumes: [
          { Name: "data", UsageData: { Size: 100 } },
          { Name: "shared", UsageData: { Size: 200 } },
          { Name: "orphan", Labels: { "openship.project": "b" }, UsageData: { Size: 50 } },
        ],
      },
      projects,
    );
    expect(result).toEqual([
      { id: "a", bytes: 130 },
      { id: "b", bytes: 55 },
    ]);
  });
  it("does not attribute ambiguous names or foreign labels to a project", () => {
    expect(
      dockerProjectStorage(
        {
          Volumes: [
            {
              Name: "openship-app-db-data",
              Labels: { "openship.project": "a" },
              UsageData: { Size: 80 },
            },
            { Name: "openship-app-unknown", UsageData: { Size: 90 } },
            {
              Name: "openship-app-forged",
              Labels: { "openship.project": "foreign" },
              UsageData: { Size: 200 },
            },
          ],
        },
        projects,
      ),
    ).toEqual([
      { id: "a", bytes: 80 },
      { id: "b", bytes: 0 },
    ]);
  });
  it("keeps unavailable measurements unknown instead of displaying zero", () => {
    expect(
      dockerProjectStorage(
        { Containers: [{ Labels: { "openship.project": "a" }, SizeRw: -1 }] },
        projects,
      ),
    ).toEqual([
      { id: "a", bytes: null },
      { id: "b", bytes: 0 },
    ]);
  });
  it("counts volume data when the daemon omits a zero-byte writable layer", () => {
    // Docker /system/df uses an omitempty integer for SizeRw. A read-only
    // container can therefore have no SizeRw key while its volume holds data.
    expect(
      dockerProjectStorage(
        {
          Containers: [
            { Labels: { "openship.project": "a" }, Mounts: [{ Type: "volume", Name: "data" }] },
            { Labels: { "openship.project": "b" } },
          ],
          Volumes: [{ Name: "data", UsageData: { Size: 8192 } }],
        },
        projects,
      ),
    ).toEqual([
      { id: "a", bytes: 8192 },
      { id: "b", bytes: 0 },
    ]);
  });
});
