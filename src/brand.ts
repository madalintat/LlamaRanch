import "./brand/theme.ts";
import { mountDither } from "./dither.ts";
// Retain instance reference to avoid stacked loops under HMR.
export const _dither = mountDither();
