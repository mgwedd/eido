import { spawn } from "node:child_process"
import { validateGateKeychainResult } from "@eido/schemas"
import type { GateKeychainResult } from "@eido/schemas"

export type KeychainCommand = {
  operation: "get" | "set" | "delete"
  path: string
  account: string
  data?: string
}

/** Fixed source only in argv. Requests and secret bytes travel over private stdin/stdout pipes. */
export const KEYCHAIN_SCRIPT = String.raw`
ObjC.import('Foundation');
ObjC.import('Security');
function run() {
  try {
    var status = $.SecKeychainSetUserInteractionAllowed(false);
    if (status !== 0) return JSON.stringify({status: status});
    var bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));
    if (typeof input.path !== 'string' || input.path.charAt(0) !== '/' ||
        typeof input.account !== 'string' ||
        ['get', 'set', 'delete'].indexOf(input.operation) < 0) {
      return JSON.stringify({status: -50});
    }
    var keychain = Ref();
    status = $.SecKeychainOpen(input.path, keychain);
    if (status !== 0) return JSON.stringify({status: -1});
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
      if (status !== 0) return JSON.stringify({status: status});
      return JSON.stringify({status: 0, data: ObjC.unwrap(C(result[0]).base64EncodedStringWithOptions(0))});
    }
    if (input.operation === 'delete') return JSON.stringify({status: $.SecItemDelete(query)});
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
    return JSON.stringify({status: status});
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
    child.stdin.end(JSON.stringify(command))
  })
}
