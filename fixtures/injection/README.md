# Injection fixtures

Synthetic inputs for the material fence in `packages/core/src/inference/fence.ts` (#281). Every text is invented; hosts are `example.invalid`.

- `cases.json`: the adversarial corpus. Each case has the text as received, the text after normalization (what the model reads and the owner is shown), and the reasons `fence()` flags. It covers forged `material` and `summary` tags in any case, spacing or width, another request's boundary, a boundary escape with a forged opening tag (invented `id`, `trust` and `signature` attributes), ChatML, Llama 3, Gemma and Mistral markers, a zero-width split marker, tag characters, a bidi override, boundary confusion, and one clean case. `packages/core/src/inference/injection.test.ts` sends the cases through the model client to the stub server and asserts on the token ids it receives.
- `forged-fence.ts.txt`: a prompt builder that writes its own fence. `packages/core/src/inference/fence-lint.test.ts` lints it with core's ESLint config and expects the `no-restricted-syntax` rule to report each marked line. It is a `.txt` file so no build, typecheck or lint run picks it up.
