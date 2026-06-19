use std::io::{self, Write};

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        std::process::exit(prime_agent_cli::run_tui_from_stdio());
    }

    let output = prime_agent_cli::run(args);
    write_or_exit(io::stdout().lock(), output.stdout.as_bytes(), 0);
    write_or_exit(
        io::stderr().lock(),
        output.stderr.as_bytes(),
        output.exit_code,
    );
    std::process::exit(output.exit_code);
}

fn write_or_exit(mut writer: impl Write, bytes: &[u8], broken_pipe_exit_code: i32) {
    if let Err(error) = writer.write_all(bytes) {
        if error.kind() == io::ErrorKind::BrokenPipe {
            std::process::exit(broken_pipe_exit_code);
        }
        eprintln!("prime-agent-rust: failed writing output: {error}");
        std::process::exit(1);
    }
}
