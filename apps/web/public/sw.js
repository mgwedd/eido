/* global classifyRequest, isCacheableResponse */
/* Eido service worker. Routing rules live in sw-routing.js. No push handling here. */
importScripts("/sw-routing.js")

var CACHE = "eido-shell-v1"

self.addEventListener("install", function () {
  self.skipWaiting()
})

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) {
              return name !== CACHE
            })
            .map(function (name) {
              return caches.delete(name)
            })
        )
      })
      .then(function () {
        return self.clients.claim()
      })
  )
})

function store(request, response) {
  var cacheable = isCacheableResponse({
    status: response.status,
    type: response.type,
    cacheControl: response.headers.get("Cache-Control"),
  })
  if (!cacheable) return Promise.resolve()
  var copy = response.clone()
  return caches.open(CACHE).then(function (cache) {
    return cache.put(request, copy)
  })
}

function networkFirst(event, fallbackUrl) {
  var request = event.request
  return fetch(request)
    .then(function (response) {
      event.waitUntil(store(request, response))
      return response
    })
    .catch(function () {
      return caches.match(request).then(function (cached) {
        if (cached) return cached
        if (fallbackUrl) return caches.match(fallbackUrl)
        return Response.error()
      })
    })
}

function cacheFirst(event) {
  var request = event.request
  return caches.match(request).then(function (cached) {
    if (cached) return cached
    return fetch(request).then(function (response) {
      event.waitUntil(store(request, response))
      return response
    })
  })
}

self.addEventListener("fetch", function (event) {
  var request = event.request
  var kind = classifyRequest({
    method: request.method,
    url: request.url,
    origin: self.location.origin,
    mode: request.mode,
    hasAuthorization: request.headers.has("Authorization"),
  })

  if (kind === "static") event.respondWith(cacheFirst(event))
  else if (kind === "navigation") event.respondWith(networkFirst(event, "/"))
  else if (kind === "api-read") event.respondWith(networkFirst(event, null))
})
