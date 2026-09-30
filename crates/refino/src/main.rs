//! Binary entry point: run the CLI and exit with its status code.

fn main() {
    let code = refino::run_from_env();
    std::process::exit(code);
}
