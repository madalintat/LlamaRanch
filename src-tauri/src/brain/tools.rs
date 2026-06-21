//! Tool registry + the Phase-2a safe tools (get_time, calculate). No tool here
//! touches the filesystem or network (that's Phase 2b). Tools never panic.
use serde_json::{json, Value};

pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> Value; // JSON Schema
    fn run(&self, args: &Value) -> Result<String, String>;
}

pub struct ToolRegistry {
    tools: Vec<Box<dyn Tool>>,
}

impl ToolRegistry {
    pub fn with_defaults() -> Self {
        ToolRegistry { tools: vec![Box::new(Clock), Box::new(Calculator)] }
    }
    /// OpenAI `tools` array for the request.
    pub fn openai_tools(&self) -> Value {
        Value::Array(
            self.tools
                .iter()
                .map(|t| json!({
                    "type": "function",
                    "function": { "name": t.name(), "description": t.description(), "parameters": t.parameters() }
                }))
                .collect(),
        )
    }
    /// Dispatch by name; parse `args_json` (a JSON string); return result or error TEXT (never panic).
    pub fn run(&self, name: &str, args_json: &str) -> String {
        let args: Value = serde_json::from_str(args_json).unwrap_or(Value::Null);
        match self.tools.iter().find(|t| t.name() == name) {
            Some(t) => match t.run(&args) {
                Ok(s) => s,
                Err(e) => format!("error: {e}"),
            },
            None => format!("error: unknown tool '{name}'"),
        }
    }
}

struct Clock;
impl Tool for Clock {
    fn name(&self) -> &str { "get_time" }
    fn description(&self) -> &str { "Get the current local date and time as an ISO-8601 string." }
    fn parameters(&self) -> Value { json!({ "type": "object", "properties": {} }) }
    fn run(&self, _args: &Value) -> Result<String, String> {
        // std-only local time: seconds since epoch (UTC). Good enough for the model.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?;
        Ok(format!("unix_seconds={} (UTC)", now.as_secs()))
    }
}

struct Calculator;
impl Tool for Calculator {
    fn name(&self) -> &str { "calculate" }
    fn description(&self) -> &str { "Evaluate an arithmetic expression (+ - * /, parentheses). Returns the number." }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "expression": { "type": "string", "description": "e.g. (2+3)*4" } },
            "required": ["expression"]
        })
    }
    fn run(&self, args: &Value) -> Result<String, String> {
        let expr = args.get("expression").and_then(|v| v.as_str()).ok_or("missing 'expression'")?;
        eval_expr(expr).map(|n| {
            // print integers without a trailing .0
            if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") }
        })
    }
}

/// Pure recursive-descent evaluator: + - * /, parentheses, unary minus, decimals.
pub fn eval_expr(input: &str) -> Result<f64, String> {
    let tokens = tokenize(input)?;
    let mut p = Parser { tokens, pos: 0 };
    let v = p.expr()?;
    if p.pos != p.tokens.len() {
        return Err("unexpected trailing input".into());
    }
    Ok(v)
}

#[derive(Clone, Debug, PartialEq)]
enum Tok { Num(f64), Plus, Minus, Star, Slash, LParen, RParen }

fn tokenize(s: &str) -> Result<Vec<Tok>, String> {
    let mut out = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' => { i += 1; }
            '+' => { out.push(Tok::Plus); i += 1; }
            '-' => { out.push(Tok::Minus); i += 1; }
            '*' => { out.push(Tok::Star); i += 1; }
            '/' => { out.push(Tok::Slash); i += 1; }
            '(' => { out.push(Tok::LParen); i += 1; }
            ')' => { out.push(Tok::RParen); i += 1; }
            c if c.is_ascii_digit() || c == '.' => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') { i += 1; }
                let num: String = chars[start..i].iter().collect();
                out.push(Tok::Num(num.parse().map_err(|_| format!("bad number '{num}'"))?));
            }
            other => return Err(format!("unexpected character '{other}'")),
        }
    }
    Ok(out)
}

struct Parser { tokens: Vec<Tok>, pos: usize }
impl Parser {
    fn peek(&self) -> Option<&Tok> { self.tokens.get(self.pos) }
    fn expr(&mut self) -> Result<f64, String> {
        let mut v = self.term()?;
        while let Some(t) = self.peek() {
            match t {
                Tok::Plus => { self.pos += 1; v += self.term()?; }
                Tok::Minus => { self.pos += 1; v -= self.term()?; }
                _ => break,
            }
        }
        Ok(v)
    }
    fn term(&mut self) -> Result<f64, String> {
        let mut v = self.factor()?;
        while let Some(t) = self.peek() {
            match t {
                Tok::Star => { self.pos += 1; v *= self.factor()?; }
                Tok::Slash => {
                    self.pos += 1;
                    let d = self.factor()?;
                    if d == 0.0 { return Err("division by zero".into()); }
                    v /= d;
                }
                _ => break,
            }
        }
        Ok(v)
    }
    fn factor(&mut self) -> Result<f64, String> {
        match self.peek().cloned() {
            Some(Tok::Num(n)) => { self.pos += 1; Ok(n) }
            Some(Tok::Minus) => { self.pos += 1; Ok(-self.factor()?) }
            Some(Tok::LParen) => {
                self.pos += 1;
                let v = self.expr()?;
                match self.peek() {
                    Some(Tok::RParen) => { self.pos += 1; Ok(v) }
                    _ => Err("expected ')'".into()),
                }
            }
            _ => Err("expected a number".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calc_precedence_and_parens() {
        assert_eq!(eval_expr("2+3*4").unwrap(), 14.0);
        assert_eq!(eval_expr("(2+3)*4").unwrap(), 20.0);
        assert_eq!(eval_expr("-3 + 5").unwrap(), 2.0);
        assert_eq!(eval_expr("10 / 4").unwrap(), 2.5);
    }
    #[test]
    fn calc_errors() {
        assert!(eval_expr("1/0").is_err());
        assert!(eval_expr("2+").is_err());
        assert!(eval_expr("abc").is_err());
        assert!(eval_expr("2 2").is_err());
    }
    #[test]
    fn registry_exposes_and_dispatches() {
        let r = ToolRegistry::with_defaults();
        let tools = r.openai_tools();
        let names: Vec<&str> = tools.as_array().unwrap().iter()
            .map(|t| t["function"]["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"get_time") && names.contains(&"calculate"));
        assert_eq!(r.run("calculate", r#"{"expression":"6*7"}"#), "42");
        assert!(r.run("calculate", r#"{"expression":"1/0"}"#).starts_with("error:"));
        assert!(r.run("nope", "{}").starts_with("error: unknown tool"));
    }
}
