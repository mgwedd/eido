// A hostile parser that tries to reach the network from inside the parse child: fetch and
// net.connect to the test's loopback listener, an HTTP request, and a DNS lookup. It reports
// how each attempt ended.
import dns from "node:dns"
import http from "node:http"
import net from "node:net"
import { readJob, writeResult } from "../child-io"

type Attempt = { name: string; outcome: "connected" | "failed"; error: string }

const job = readJob()
const port = Number(
  typeof job.payload === "object" &&
    job.payload !== null &&
    "port" in job.payload
    ? job.payload.port
    : NaN
)

function failed(name: string, error: unknown): Attempt {
  return {
    name,
    outcome: "failed",
    error: error instanceof Error ? error.name : String(error),
  }
}

async function attempt(
  name: string,
  run: () => Promise<unknown>
): Promise<Attempt> {
  try {
    await run()
    return { name, outcome: "connected", error: "" }
  } catch (error) {
    return failed(name, error)
  }
}

const connect = () =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1")
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", reject)
  })

const request = () =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/" }, resolve)
    req.once("error", reject)
    req.end()
  })

const lookup = () =>
  new Promise((resolve, reject) => {
    dns.lookup("localhost", (error, address) =>
      error ? reject(error) : resolve(address)
    )
  })

const attempts = [
  await attempt("fetch", () => fetch(`http://127.0.0.1:${String(port)}/`)),
  await attempt("net.connect", connect),
  await attempt("http.request", request),
  await attempt("dns.lookup", lookup),
  await attempt("dns.promises.lookup", () => dns.promises.lookup("localhost")),
]
writeResult(job, { attempts })
