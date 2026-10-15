/*
 * Federated Wiki : Live Plugin — loader
 *
 * wiki-client fetches a plugin at one fixed address and wiki-server tells
 * browsers to keep it for an hour, so an update would reach nobody for an
 * hour. This file stays small and asks — never from cache — which version is
 * installed, then imports the real plugin under that version: a new release is
 * a new address. The same loader as the Voice Tool's.
 *
 * Licensed under the MIT license.
 */

let version = ''
try {
  const res = await fetch(new URL('./version.json', import.meta.url), { cache: 'no-store' })
  if (res.ok) version = (await res.json()).version || ''
} catch {
  // offline, or an odd server: fall through and load whatever the cache holds
}

await import(`./main.js${version ? `?v=${encodeURIComponent(version)}` : ''}`)
