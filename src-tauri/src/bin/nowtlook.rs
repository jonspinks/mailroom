//! The name this app had before 0.36.0. An install from then has scripts,
//! key bindings and an autostart entry that run `target/release/nowtlook`,
//! and the update script that pulls the rename restarts that path. This
//! hands every such launch, with its arguments, to `mailroom` beside it.

use std::os::unix::process::CommandExt;

fn main() {
    let Ok(exe) = std::env::current_exe() else { std::process::exit(1) };
    let target = exe.with_file_name("mailroom");
    let err = std::process::Command::new(&target).args(std::env::args_os().skip(1)).exec();
    eprintln!("nowtlook: could not start {}: {err}", target.display());
    std::process::exit(1);
}
