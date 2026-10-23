// A parser that never returns: the sandbox must kill it at the wall-clock limit.
import { readJob } from "../child-io"

readJob()
for (;;) {
  // spin
}
