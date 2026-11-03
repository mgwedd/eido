use std::io::{Read, Write};

fn main() {
    let mut input = Vec::new();
    let limit = eido_file_helper::MAX_REQUEST_BYTES as u64 + 1;
    let read = std::io::stdin().lock().take(limit).read_to_end(&mut input);
    let response = match read {
        Ok(_) => eido_file_helper::handle(&input),
        Err(_) => eido_file_helper::handle(b""),
    };
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{response}")
        .and_then(|()| out.flush())
        .is_err()
    {
        std::process::exit(2);
    }
}
