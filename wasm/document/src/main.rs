mod facade;

#[cfg(target_os = "emscripten")]
mod abi;

#[cfg(target_os = "emscripten")]
fn main() {}

#[cfg(not(target_os = "emscripten"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let input = std::fs::read(
        args.get(2)
            .ok_or("expected open FILE or set FILE REQUEST OUTPUT")?,
    )?;
    let (json, bytes) = match args.get(1).map(String::as_str) {
        Some("open") => facade::open(&input),
        Some("set") => facade::set_expression(
            &input,
            &std::fs::read(args.get(3).ok_or("expected REQUEST")?)?,
        ),
        _ => return Err("expected open or set".into()),
    };
    if let Some(bytes) = bytes {
        let output = args.get(4).ok_or("expected OUTPUT")?;
        use std::io::Write;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?
            .write_all(&bytes)?;
    }
    println!("{}", serde_json::to_string(&json)?);
    Ok(())
}
