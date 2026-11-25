import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { startKeychainWorker, unlockKeychain } from "./keychain-bridge"
import { KeychainVault } from "./keychain-vault"
import { vaultContract } from "./vault-contract"
import { vaultKeyId } from "./vault"

// This file never opens the login/default keychain. Every native operation names a fresh path.
const FIXTURE_SCRIPT = String.raw`
ObjC.import('Foundation');ObjC.import('Security');
ObjC.bindFunction('SecKeychainCopySettings',['int',['void *','void *']]);
function run() {
  $.SecKeychainSetUserInteractionAllowed(false);
  var r=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile,$.NSUTF8StringEncoding)));
  var keychain=Ref(), status;
  var password=$.NSString.stringWithString(r.password).dataUsingEncoding($.NSUTF8StringEncoding);
  if(r.operation==='create') return String($.SecKeychainCreate(r.path,password.length,password.bytes,false,null,keychain));
  status=$.SecKeychainOpen(r.path,keychain);
  if(status!==0)return String(status);
  if(r.operation==='lock')return String($.SecKeychainLock(keychain[0]));
  if(r.operation==='delete')return String($.SecKeychainDelete(keychain[0]));
  if(r.operation==='unlock')return String($.SecKeychainUnlock(keychain[0],password.length,password.bytes,true));
  if(r.operation==='settings'){
    var b=$.NSMutableData.alloc.initWithBase64EncodedStringOptions($.NSString.stringWithString('AQAAAAAAAAAAAAAA'),0);
    status=$.SecKeychainCopySettings(keychain[0],b.mutableBytes);
    return status+' '+ObjC.unwrap(b.base64EncodedStringWithOptions(0));
  }
  if(r.operation==='inspect') {
    var C=function(v){return ObjC.castRefToObject(v)};
    var q=$.NSMutableDictionary.alloc.init;
    q.setObjectForKey(C($.kSecClassGenericPassword),C($.kSecClass));
    q.setObjectForKey($.NSString.stringWithString('com.eido.gate.vault'),C($.kSecAttrService));
    q.setObjectForKey($.NSString.stringWithString(r.account),C($.kSecAttrAccount));
    q.setObjectForKey(C($.kCFBooleanFalse),C($.kSecAttrSynchronizable));
    q.setObjectForKey($.NSArray.arrayWithObject(C(keychain[0])),C($.kSecMatchSearchList));
    q.setObjectForKey(C($.kCFBooleanTrue),C($.kSecReturnAttributes));
    var result=Ref();
    status=$.SecItemCopyMatching(q,result);
    if(status!==0)return String(status);
    return JSON.stringify(ObjC.deepUnwrap(C(result[0])));
  }
  return '-50';
}
`

function nativeFixture(input: {
  operation: string
  path: string
  password: string
  account?: string
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", FIXTURE_SCRIPT],
      { timeout: 10_000 },
      (error, stdout) => {
        if (error) reject(new Error("test keychain operation failed"))
        else resolve(stdout.trim())
      }
    )
    child.stdin?.end(JSON.stringify(input))
  })
}
/** SecKeychainSettings as stored: {UInt32 version; Boolean lockOnSleep; Boolean useLockInterval; UInt32 lockInterval}. */
async function autoLock(f: { path: string; password: string }) {
  const [status, base64] = (
    await nativeFixture({ ...f, operation: "settings" })
  ).split(" ")
  expect(status).toBe("0")
  const bytes = Buffer.from(base64 ?? "", "base64")
  return { lockOnSleep: bytes[4] === 1, interval: bytes.readUInt32LE(8) }
}
const KEY = { connector: "proton", kind: "password", client: "none" } as const
const fixtures: { dir: string; path: string; password: string }[] = []
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "eido-keychain-native-"))
  const f = {
    dir,
    path: join(dir, "test.keychain-db"),
    password: randomBytes(32).toString("hex"),
  }
  fixtures.push(f)
  expect(await nativeFixture({ ...f, operation: "create" })).toBe("0")
  await chmod(f.path, 0o600)
  return { ...f, vault: new KeychainVault({ path: f.path }) }
}
afterAll(async () => {
  for (const f of fixtures) {
    await nativeFixture({ ...f, operation: "unlock" })
    expect(await nativeFixture({ ...f, operation: "delete" })).toBe("0")
    await rm(f.dir, { recursive: true, force: true })
  }
}, 60_000)

// Security.framework is macOS-only. Other platforms exercise the process and adapter mocks.
describe.skipIf(process.platform !== "darwin")(
  "dedicated native Keychain",
  { timeout: 30_000 },
  () => {
    vaultContract("KeychainVault", async () => (await fixture()).vault)

    test("preserves empty, multiline, Unicode, NUL and unpaired-surrogate strings across instances", async () => {
      const f = await fixture()
      for (const secret of ["", 'line one\n"quoted"\\text\0🔐', "\ud800"]) {
        await f.vault.set(KEY, secret)
        expect(await new KeychainVault({ path: f.path }).get(KEY)).toBe(secret)
      }
    })

    test("stores a local-only credential in an owner-private throwaway keychain", async () => {
      const f = await fixture()
      await f.vault.set(KEY, "synthetic-native-marker")
      const raw: unknown = JSON.parse(
        await nativeFixture({
          ...f,
          operation: "inspect",
          account: vaultKeyId(KEY),
        })
      )
      expect(raw).toMatchObject({
        svce: "com.eido.gate.vault",
        acct: '["proton","password","none"]',
        class: "genp",
      })
      // Legacy file keychains omit sync=false in returned attributes; synchronizable items are excluded by the native query.
      expect(
        typeof raw === "object" && raw !== null && "sync" in raw
          ? raw.sync
          : false
      ).toBe(false)
      expect((await stat(f.path)).mode & 0o077).toBe(0)
    })

    test("locked and missing keychains fail closed without exposing a secret or prompting", async () => {
      const f = await fixture()
      const secret = "synthetic-locked-marker"
      await f.vault.set(KEY, secret)
      expect(await nativeFixture({ ...f, operation: "lock" })).toBe("0")
      const error = await f.vault.get(KEY).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(secret)
      await expect(
        new KeychainVault({ path: join(f.dir, "missing.keychain-db") }).get(KEY)
      ).rejects.toThrow("Keychain file must exist")
    })

    test("a wrong passphrase leaves the keychain locked; the right one unlocks it with auto-lock off and the vault works", async () => {
      const f = await fixture()
      await f.vault.set(KEY, "synthetic-before-lock")
      // A new file keychain locks on sleep and after 300 s of idle.
      expect(await autoLock(f)).toEqual({ lockOnSleep: true, interval: 300 })
      expect(await nativeFixture({ ...f, operation: "lock" })).toBe("0")
      expect(
        await unlockKeychain(f.path, Buffer.from("synthetic-wrong-passphrase"))
      ).toBe("locked")
      await expect(f.vault.get(KEY)).rejects.toThrow(
        "Keychain credential could not be read"
      )
      expect(await unlockKeychain(f.path, Buffer.from(f.password))).toBe(
        "unlocked"
      )
      // An INT32_MAX interval is what `security show-keychain-info` reports as no-timeout.
      expect(await autoLock(f)).toEqual({
        lockOnSleep: false,
        interval: 0x7fffffff,
      })
      expect(await f.vault.get(KEY)).toBe("synthetic-before-lock")
      await f.vault.set(KEY, "synthetic-after-unlock")
      expect(await f.vault.get(KEY)).toBe("synthetic-after-unlock")
      await f.vault.delete(KEY)
      expect(await f.vault.get(KEY)).toBeUndefined()
    })

    test("the real worker argv contains only fixed source, never the request or secret", async () => {
      const f = await fixture()
      const secret = "synthetic-ps-inspection-marker"
      const encoded = Buffer.from(secret, "utf16le").toString("base64")
      const child = startKeychainWorker()
      try {
        if (child.pid === undefined) throw new Error("worker did not start")
        const args = await new Promise<string>((resolve, reject) =>
          execFile(
            "/bin/ps",
            ["-p", String(child.pid), "-o", "command="],
            (error, stdout) =>
              error
                ? reject(new Error("process argument inspection failed"))
                : resolve(stdout)
          )
        )
        expect(args).toContain("/usr/bin/osascript -l JavaScript -e")
        expect(args).not.toContain(f.path)
        expect(args).not.toContain(secret)
        expect(args).not.toContain(encoded)
        let output = ""
        child.stdout.setEncoding("utf8").on("data", (text: string) => {
          output += text
        })
        child.stderr.resume()
        const closed = new Promise<number | null>((resolve) =>
          child.on("close", resolve)
        )
        child.stdin.end(
          JSON.stringify({
            operation: "set",
            path: f.path,
            account: vaultKeyId(KEY),
            data: encoded,
          })
        )
        expect(await closed).toBe(0)
        expect(JSON.parse(output)).toEqual({ status: 0 })
        expect(await f.vault.get(KEY)).toBe(secret)
      } finally {
        child.kill()
      }
    })
  }
)
