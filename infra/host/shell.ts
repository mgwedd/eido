/** `value` quoted for /bin/sh: bare when it is safe, else single-quoted. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/.,:=+@%-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`
}
