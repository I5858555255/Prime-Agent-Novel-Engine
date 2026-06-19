fn main() {
    let output = prime_agent_cli::run_from_env();
    print!("{}", output.stdout);
    eprint!("{}", output.stderr);
    std::process::exit(output.exit_code);
}
