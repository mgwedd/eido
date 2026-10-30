import { createHash, X509Certificate } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** An ephemeral synthetic certificate and key; neither is committed to the repository. */
export function createTestCertificate() {
  const directory = mkdtempSync(join(tmpdir(), "eido-bridge-cert-"))
  const certPath = join(directory, "cert.pem")
  const keyPath = join(directory, "key.pem")
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=synthetic-bridge",
      ],
      { stdio: "ignore" }
    )
    const cert = readFileSync(certPath, "utf8")
    const key = readFileSync(keyPath, "utf8")
    const sha256 = createHash("sha256")
      .update(new X509Certificate(cert).raw)
      .digest("hex")
    return {
      cert,
      key,
      certPath,
      sha256,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
