import { config } from "@eido/eslint-config/base"

const MAIL_DELETE =
  "The gate never deletes mail permanently: move to Trash instead (#195)."

const METHODS =
  "/^(messageDelete|expunge|mailboxDelete|mailboxClose|mailboxRename)$/"
const COMMANDS = "/^\\s*(UID\\s+)?(EXPUNGE|CLOSE|DELETE|STORE)\\b/i"

// Lint cannot follow a string built at run time ('ex' + 'punge', '\Del' + 'eted'). The adapter
// tests back this up: the fake Bridge records every command the gate sends and they assert that
// none is EXPUNGE, CLOSE, DELETE, STORE or carries \Deleted (bridge.test.ts).

export default [
  ...config,
  {
    files: ["**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        // The imapflow methods that delete, by name in any position: member access, a
        // destructured or renamed key, or any other identifier.
        { selector: `Identifier[name=${METHODS}]`, message: MAIL_DELETE },
        // The same names as strings: computed access, Reflect.get, string-keyed destructuring.
        { selector: `Literal[value=${METHODS}]`, message: MAIL_DELETE },
        {
          selector: `TemplateElement[value.raw=${METHODS}]`,
          message: MAIL_DELETE,
        },
        // Raw IMAP through the client, which could send EXPUNGE, CLOSE, DELETE or STORE.
        {
          selector:
            "MemberExpression[object.name=/^(client|imap)$/][property.name=/^(run|exec)$/]",
          message: MAIL_DELETE,
        },
        {
          selector: `CallExpression[callee.property.name=/^(run|exec)$/] > Literal.arguments[value=${COMMANDS}]`,
          message: MAIL_DELETE,
        },
        {
          selector: `CallExpression[callee.property.name=/^(run|exec)$/] > TemplateLiteral.arguments > TemplateElement[value.raw=${COMMANDS}]`,
          message: MAIL_DELETE,
        },
        // The \Deleted flag that STORE sets before an expunge.
        {
          selector: "Literal[value=/\\\\Deleted/i]",
          message: MAIL_DELETE,
        },
        {
          selector: "TemplateElement[value.raw=/Deleted/i]",
          message: MAIL_DELETE,
        },
      ],
    },
  },
]
