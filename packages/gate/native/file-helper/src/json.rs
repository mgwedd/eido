//! The request subset: objects, strings and nonnegative integer limits.
//! Arrays, literals, fractional/negative numbers and duplicate keys are refused;
//! operation-specific parsing checks every key and the range of every limit.

#[derive(Debug, PartialEq)]
pub enum Value {
    Str(String),
    Num(usize),
    Obj(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            Value::Str(_) | Value::Num(_) => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            Value::Obj(_) | Value::Num(_) => None,
        }
    }

    pub fn as_usize(&self) -> Option<usize> {
        if let Value::Num(n) = self {
            Some(*n)
        } else {
            None
        }
    }

    pub fn keys(&self) -> Vec<&str> {
        match self {
            Value::Obj(fields) => fields.iter().map(|(k, _)| k.as_str()).collect(),
            Value::Str(_) | Value::Num(_) => Vec::new(),
        }
    }
}

const MAX_DEPTH: usize = 8;

pub fn parse(input: &str) -> Result<Value, &'static str> {
    let mut p = Parser {
        b: input.as_bytes(),
        i: 0,
    };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.b.len() {
        return Err("trailing data");
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn value(&mut self, depth: usize) -> Result<Value, &'static str> {
        self.ws();
        match self.peek() {
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b'{') => self.object(depth),
            Some(b'0'..=b'9') => {
                let start = self.i;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
                if self.i - start > 1 && self.b[start] == b'0' {
                    return Err("invalid number");
                }
                let value = std::str::from_utf8(&self.b[start..self.i])
                    .map_err(|_| "invalid number")?
                    .parse::<usize>()
                    .map_err(|_| "invalid number")?;
                Ok(Value::Num(value))
            }
            Some(_) => Err("unsupported value"),
            None => Err("unexpected end"),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, &'static str> {
        if depth >= MAX_DEPTH {
            return Err("too deep");
        }
        self.i += 1;
        let mut fields: Vec<(String, Value)> = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Value::Obj(fields));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err("expected key");
            }
            let key = self.string()?;
            if fields.iter().any(|(k, _)| *k == key) {
                return Err("duplicate key");
            }
            self.ws();
            if self.peek() != Some(b':') {
                return Err("expected colon");
            }
            self.i += 1;
            let v = self.value(depth + 1)?;
            fields.push((key, v));
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Value::Obj(fields));
                }
                _ => return Err("expected comma or brace"),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, &'static str> {
        let digits = self.b.get(self.i..self.i + 4).ok_or("bad escape")?;
        let mut n = 0u32;
        for d in digits {
            let v = (*d as char).to_digit(16).ok_or("bad escape")?;
            n = n * 16 + v;
        }
        self.i += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, &'static str> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.b.len() && self.b[self.i] != b'"' && self.b[self.i] != b'\\' {
                if self.b[self.i] < 0x20 {
                    return Err("control character in string");
                }
                self.i += 1;
            }
            // The input is a &str and we split only at ASCII bytes, so the slice is UTF-8.
            out.push_str(std::str::from_utf8(&self.b[start..self.i]).map_err(|_| "bad utf-8")?);
            match self.peek() {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let e = self.peek().ok_or("bad escape")?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&hi) {
                                if self.b.get(self.i..self.i + 2) != Some(b"\\u") {
                                    return Err("lone surrogate");
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err("lone surrogate");
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else {
                                hi
                            };
                            out.push(char::from_u32(code).ok_or("lone surrogate")?);
                        }
                        _ => return Err("bad escape"),
                    }
                }
                _ => return Err("unterminated string"),
            }
        }
    }
}

/// A JSON string literal for `s`.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
