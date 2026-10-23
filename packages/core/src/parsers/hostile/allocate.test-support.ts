// A parser that allocates until the heap cap stops it.
import { readJob } from "../child-io"

readJob()
const hoard: unknown[] = []
for (;;) {
  hoard.push(Array.from({ length: 1024 }, (_, i) => ({ i })))
}
