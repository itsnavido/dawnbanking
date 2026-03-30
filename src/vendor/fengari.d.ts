declare module 'fengari' {
  // Minimal typings to keep the project compiling.
  // The runtime APIs are used dynamically via Fengari's JS interface.
  export const lua: any
  export const lauxlib: any
  export const lualib: any
  export const to_luastring: any
}

