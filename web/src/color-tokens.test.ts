import { describe, expect, it } from 'vitest';
import { stylesSource } from 'virtual:meet-styles-source';
import tokens from '../../fixtures/color-tokens.json';

/*
 * The colour roles the Mac, iOS and web all draw (meet#599). The web's side of
 * the pin: every role in `fixtures/color-tokens.json` is read out of the custom
 * properties in `styles.css`, in the dark root, the explicit light theme and
 * the automatic light theme. `Tests/SurfaceMirrorTests.swift` (Mac) and
 * `iOSTests/MobileColorTokensTests.swift` (iOS) hold the other two surfaces to
 * the same file. Change the fixture first, then the surface that moved.
 */

const css = stylesSource;

type Value = string | { rgb: string; alpha: number };
interface Role {
  web: string | null;
  mac: string | null;
  ios: string | null;
  dark: Value;
  light: Value;
}
const roles = tokens.roles as Record<string, Role>;

/** The text between the `{` that follows `opener` and its matching `}`. */
function block(opener: string): string {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`styles.css has no ${opener} block`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`styles.css ${opener} block does not close`);
}

/** Custom properties declared directly in a block, comments dropped. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  }
  return out;
}

/** What the browser computes for `name` on an element with this scope. */
function resolve(scope: Map<string, string>, name: string, trail: string[] = []): string {
  if (trail.includes(name)) throw new Error(`${name} refers to itself`);
  const raw = scope.get(name);
  if (raw === undefined) throw new Error(`${name} is not declared in styles.css`);
  return raw.replace(/var\((--[\w-]+)\)/g, (_, inner: string) => resolve(scope, inner, [...trail, name]));
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/** `#rrggbb` stays a string; `rgb(r g b / a)` becomes { rgb, alpha }. */
function parse(value: string): Value {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const fn = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(value);
  if (!fn) throw new Error(`cannot read "${value}" as a colour`);
  const rgb = `#${hex2(Number(fn[1]))}${hex2(Number(fn[2]))}${hex2(Number(fn[3]))}`;
  return fn[4] === undefined ? rgb : { rgb, alpha: Number(fn[4]) };
}

const root = declarations(block(':root {'));
const lightOnly = declarations(block(':root[data-theme="light"] {'));
const autoLightOnly = declarations(block(':root[data-theme="auto"] {'));
const scopes: Record<string, Map<string, string>> = {
  dark: root,
  light: new Map([...root, ...lightOnly]),
  'auto, light system': new Map([...root, ...autoLightOnly]),
};

describe('Colour roles', () => {
  it('has roles, and every web role is a variable styles.css declares', () => {
    expect(tokens.version).toBe(1);
    expect(Object.keys(roles).length).toBeGreaterThan(15);
    for (const [id, role] of Object.entries(roles)) {
      expect(role.web, id).not.toBeNull();
      expect(root.has(role.web as string), `${id}: ${role.web}`).toBe(true);
    }
  });

  for (const [scopeName, scope] of Object.entries(scopes)) {
    const appearance = scopeName === 'dark' ? 'dark' : 'light';
    it.each(Object.entries(roles))(`${scopeName}: %s`, (_id, role) => {
      expect(parse(resolve(scope, role.web as string))).toEqual(role[appearance]);
    });
  }

  it('lists a difference only where a native surface really is apart from the web', () => {
    for (const d of tokens.differences) {
      const role = roles[d.role];
      expect(role, d.role).toBeDefined();
      expect(d.value, `${d.role}: a stale exception equals the fixture`).not.toEqual(role[d.appearance as 'dark' | 'light']);
      expect(d.reason.length, d.role).toBeGreaterThan(20);
      for (const surface of d.surfaces) expect(role[surface as 'mac' | 'ios'], `${d.role} on ${surface}`).not.toBeNull();
    }
  });
});
