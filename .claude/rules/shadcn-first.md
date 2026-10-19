# shadcn first

- Every UI element is a shadcn component. Add it with the shadcn CLI (`pnpm dlx shadcn@latest add <component> -c apps/web`) from the shadcn registry, or from another shadcn-compatible registry, into `packages/ui/src/components`.
- Before writing any markup for a control, layout or pattern, search the registries for it: components, blocks and community registries. Use what exists, composed, with theme tokens only.
- Hand-roll a component only when (a) the registries are exhausted, or (b) using the closest one would mean warping it: forking its internals or fighting its API to fit our needs. Prefer composing or styling through tokens and props over editing a registry component.
- Say which in the PR body: the registries searched, and why a hand-rolled component was needed.
- Colours, radii and fonts come from the theme tokens in `packages/ui/src/styles/globals.css`; no raw colour values in components or pages.
