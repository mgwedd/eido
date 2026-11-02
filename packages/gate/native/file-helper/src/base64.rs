//! Strict standard base64 (RFC 4648 section 4, padded). Non-canonical input is
//! refused so one content has exactly one encoding.

fn sextet(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub fn decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let quads = b.len() / 4;
    for (q, chunk) in b.chunks(4).enumerate() {
        let last = q + 1 == quads;
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut n = 0u32;
        for &c in &chunk[..4 - pad] {
            n = (n << 6) | sextet(c)?;
        }
        n <<= 6 * pad as u32;
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        // Bits below the last whole byte must be zero in canonical input.
        let dropped = match pad {
            1 => n & 0xFF,
            2 => n & 0xFFFF,
            _ => 0,
        };
        if dropped != 0 {
            return None;
        }
        out.extend_from_slice(&bytes[..3 - pad]);
    }
    Some(out)
}
