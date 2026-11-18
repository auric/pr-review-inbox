import { expect, test } from "vitest";
import * as dates from "../packages/dates/src/index";
import * as money from "../packages/money/src/index";

// A new export or a removed export of a package must change this list on purpose.
test("money exports", () => {
  expect(Object.keys(money).sort()).toEqual(["add", "format"]);
});

test("dates exports", () => {
  expect(Object.keys(dates).sort()).toEqual(["dayOf", "isDay"]);
});
