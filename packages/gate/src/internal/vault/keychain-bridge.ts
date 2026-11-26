import { spawn } from "node:child_process"
import { validateGateKeychainResult } from "@eido/schemas"
import type { GateKeychainResult } from "@eido/schemas"

/** Item requests. The `unlock` request is internal to `unlockKeychain`, which builds it in zeroable bytes. */
export type KeychainCommand =
  | { operation: "get" | "delete"; path: string; account: string }
  | { operation: "set"; path: string; account: string; data: string }

/**
 * Fixed source only in argv. Requests and secret bytes travel over private stdin/stdout pipes.
 * `unlock` unlocks the keychain for every process of the user and turns auto-lock off: no lock on
 * sleep, no idle timeout. The settings calls are bound with untyped pointers because JXA cannot
 * pass the SecKeychainSettings struct; the 12 bytes are {version 1, lockOnSleep, useLockInterval,
 * padding, lockInterval INT32_MAX}, and the read-back must show lock-on-sleep off and no timeout.
 * Once the unlock succeeded, any later failure locks the keychain again before it returns, so a
 * gate that refuses to start does not leave it unlocked.
 * An item request that fails, item-not-found included, reports `locked` only when
 * SecKeychainGetStatus succeeds and its unlocked bit (kSecUnlockStateStatus) is clear; any other
 * failure is reported by status alone.
 */
export const KEYCHAIN_SCRIPT = String.raw`
ObjC.import('Foundation');
ObjC.import('Security');
ObjC.bindFunction('SecKeychainSetSettings', ['int', ['void *', 'void *']]);
ObjC.bindFunction('SecKeychainCopySettings', ['int', ['void *', 'void *']]);
function bytes(base64) {
  return $.NSMutableData.alloc.initWithBase64EncodedStringOptions($.NSString.stringWithString(base64), 0);
}
function unlock(keychain, base64) {
  var secret = bytes(base64);
  if (secret.isNil()) return JSON.stringify({status: -50});
  var status = $.SecKeychainUnlock(keychain, secret.length, secret.bytes, true);
  secret.resetBytesInRange($.NSMakeRange(0, secret.length));
  if (status === -25293) return JSON.stringify({status: status, unlock: 'locked'});
  if (status !== 0) return JSON.stringify({status: status});
  try {
    status = $.SecKeychainSetSettings(keychain, bytes('AQAAAAAAAAD///9/').mutableBytes);
    if (status !== 0) return relock(keychain, status);
    var settings = bytes('AQAAAAEBAAAAAAAA');
    status = $.SecKeychainCopySettings(keychain, settings.mutableBytes);
    if (status !== 0) return relock(keychain, status);
    var read = ObjC.unwrap(settings.base64EncodedStringWithOptions(0));
    if (read !== 'AQAAAAAAAAD///9/' && read !== 'AQAAAAABAAD///9/') return relock(keychain, -1);
    return JSON.stringify({status: 0, unlock: 'unlocked'});
  } catch (_) {
    return relock(keychain, -1);
  }
}
function relock(keychain, status) {
  $.SecKeychainLock(keychain);
  return JSON.stringify({status: status});
}
function itemReply(keychain, status) {
  if (status === 0) return JSON.stringify({status: status});
  var flags = Ref();
  if ($.SecKeychainGetStatus(keychain, flags) === 0 && (flags[0] & 1) === 0) {
    return JSON.stringify({status: status, locked: true});
  }
  return JSON.stringify({status: status});
}
function run() {
  try {
    var status = $.SecKeychainSetUserInteractionAllowed(false);
    if (status !== 0) return JSON.stringify({status: status});
    var bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));
    if (typeof input.path !== 'string' || input.path.charAt(0) !== '/' ||
        (input.operation !== 'unlock' && typeof input.account !== 'string') ||
        ['get', 'set', 'delete', 'unlock'].indexOf(input.operation) < 0) {
      return JSON.stringify({status: -50});
    }
    var keychain = Ref();
    status = $.SecKeychainOpen(input.path, keychain);
    if (status !== 0) return JSON.stringify({status: -1});
    if (input.operation === 'unlock') {
      if (typeof input.data !== 'string') return JSON.stringify({status: -50});
      return unlock(keychain[0], input.data);
    }
    var C = function(value) { return ObjC.castRefToObject(value); };
    var query = $.NSMutableDictionary.alloc.init;
    query.setObjectForKey(C($.kSecClassGenericPassword), C($.kSecClass));
    query.setObjectForKey($.NSString.stringWithString('com.eido.gate.vault'), C($.kSecAttrService));
    query.setObjectForKey($.NSString.stringWithString(input.account), C($.kSecAttrAccount));
    query.setObjectForKey(C($.kCFBooleanFalse), C($.kSecAttrSynchronizable));
    query.setObjectForKey($.NSArray.arrayWithObject(C(keychain[0])), C($.kSecMatchSearchList));
    if (input.operation === 'get') {
      query.setObjectForKey(C($.kCFBooleanTrue), C($.kSecReturnData));
      query.setObjectForKey(C($.kSecMatchLimitOne), C($.kSecMatchLimit));
      var result = Ref();
      status = $.SecItemCopyMatching(query, result);
      if (status !== 0) return itemReply(keychain[0], status);
      return JSON.stringify({status: 0, data: ObjC.unwrap(C(result[0]).base64EncodedStringWithOptions(0))});
    }
    if (input.operation === 'delete') return itemReply(keychain[0], $.SecItemDelete(query));
    if (typeof input.data !== 'string') return JSON.stringify({status: -50});
    var data = $.NSData.alloc.initWithBase64EncodedStringOptions($.NSString.stringWithString(input.data), 0);
    var updates = $.NSMutableDictionary.alloc.init;
    updates.setObjectForKey(data, C($.kSecValueData));
    updates.setObjectForKey(C($.kCFBooleanFalse), C($.kSecAttrSynchronizable));
    status = $.SecItemUpdate(query, updates);
    if (status === -25300) {
      query.removeObjectForKey(C($.kSecMatchSearchList));
      query.setObjectForKey(C(keychain[0]), C($.kSecUseKeychain));
      query.setObjectForKey(data, C($.kSecValueData));
      status = $.SecItemAdd(query, null);
      if (status === -25299) {
        query.removeObjectForKey(C($.kSecUseKeychain));
        query.removeObjectForKey(C($.kSecValueData));
        query.setObjectForKey($.NSArray.arrayWithObject(C(keychain[0])), C($.kSecMatchSearchList));
        status = $.SecItemUpdate(query, updates);
      }
    }
    return itemReply(keychain[0], status);
  } catch (_) {
    return JSON.stringify({status: -1});
  }
}
`

/** Also used by the native argv-inspection test before it supplies any request bytes. */
export function startKeychainWorker() {
  return spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", KEYCHAIN_SCRIPT],
    {
      stdio: "pipe",
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin" },
    }
  )
}

export function runKeychainCommand(
  command: KeychainCommand
): Promise<GateKeychainResult> {
  return runKeychainRequest(JSON.stringify(command))
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Base64 into a buffer the caller can zero; `Buffer#toString("base64")` would leave an immutable string. */
export function base64Bytes(input: Uint8Array): Buffer {
  const out = Buffer.alloc(Math.ceil(input.length / 3) * 4, "=")
  for (let i = 0, o = 0; i < input.length; i += 3, o += 4) {
    const a = input[i] ?? 0
    const b = input[i + 1] ?? 0
    const c = input[i + 2] ?? 0
    out[o] = BASE64.charCodeAt(a >> 2)
    out[o + 1] = BASE64.charCodeAt(((a & 3) << 4) | (b >> 4))
    if (i + 1 < input.length)
      out[o + 2] = BASE64.charCodeAt(((b & 15) << 2) | (c >> 6))
    if (i + 2 < input.length) out[o + 3] = BASE64.charCodeAt(c & 63)
  }
  return out
}

/**
 * Unlocks the keychain at `path` with the passphrase bytes and turns its auto-lock off.
 * The passphrase reaches the helper only through its stdin pipe; the request buffer that carries
 * it is zeroed once the helper has exited (a pipe write may still hold the buffer until then).
 * The caller owns `passphrase` and zeroes it.
 */
export async function unlockKeychain(
  path: string,
  passphrase: Uint8Array
): Promise<"unlocked" | "locked"> {
  const encoded = base64Bytes(passphrase)
  const request = Buffer.concat([
    Buffer.from(
      `{"operation":"unlock","path":${JSON.stringify(path)},"data":"`
    ),
    encoded,
    Buffer.from('"}'),
  ])
  encoded.fill(0)
  let result: GateKeychainResult
  try {
    result = await runKeychainRequest(request)
  } finally {
    request.fill(0)
  }
  if (result.status === 0 && result.unlock === "unlocked") return "unlocked"
  if (result.unlock === "locked") return "locked"
  throw new Error("Keychain could not be unlocked")
}

function runKeychainRequest(
  request: string | Buffer
): Promise<GateKeychainResult> {
  return new Promise((resolve, reject) => {
    const child = startKeychainWorker()
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    const fail = () => reject(new Error("Keychain helper failed"))
    child.on("error", fail)
    child.stdin.on("error", fail)
    // Never forward native stderr: an OS error could contain the request or a secret.
    child.stderr.resume()
    child.stdout.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) {
        overflow = true
        child.kill()
        return
      }
      size += chunk.length
      if (size > 1024 * 1024) {
        overflow = true
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.on("close", (code) => {
      if (code !== 0 || overflow) {
        fail()
        return
      }
      try {
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const checked = validateGateKeychainResult(raw)
        if (!checked.ok) {
          fail()
          return
        }
        resolve(checked.value)
      } catch {
        fail()
      }
    })
    child.stdin.end(request)
  })
}
