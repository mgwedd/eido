import { config } from "@eido/eslint-config/base"

const MAIL_DELETE =
  "The gate never deletes mail permanently: move to Trash instead (#195)."

export default [
  ...config,
  {
    files: ["**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[property.name=/^(messageDelete|expunge|mailboxDelete|mailboxClose|mailboxRename)$/]",
          message: MAIL_DELETE,
        },
        {
          selector:
            "MemberExpression[computed=true][property.value=/^(messageDelete|expunge|mailboxDelete|mailboxClose|mailboxRename)$/]",
          message: MAIL_DELETE,
        },
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
