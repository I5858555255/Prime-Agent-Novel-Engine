fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        std::process::exit(prime_agent_cli::run_interactive_from_stdio());
    }

    let output = prime_agent_cli::run(args);
    print!("{}", output.stdout);
    eprint!("{}", output.stderr);
    std::process::exit(output.exit_code);
}
