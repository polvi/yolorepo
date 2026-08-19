import { readFileSync } from "node:fs";
import { join } from "node:path";
export const FIXTURES = new URL("../../../fixtures/protocol/", import.meta.url).pathname;
export const DATA = new URL("./data/", import.meta.url).pathname;
export const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
export const dataText = (name: string) => readFileSync(join(DATA, name), "utf8");
export const dataBytes = (name: string) => new Uint8Array(readFileSync(join(DATA, name)));
