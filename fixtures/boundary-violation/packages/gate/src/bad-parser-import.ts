// Deliberately breaks gate-has-no-parsers: the gate imports a document parser library.
// CI asserts that dependency-cruiser fails on this file.
import PostalMime from "postal-mime"

export const parser = PostalMime
