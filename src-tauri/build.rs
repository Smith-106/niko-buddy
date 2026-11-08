fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    // DEBT-20261108-04：给**测试**目标补上 comctl32 v6 的 SxS 依赖（不碰 bin target）。
    //
    // 注意实测边界：cargo 的 `rustc-link-arg-tests` **不会**作用于 lib 的单测二进制
    // （lib 以 --test 重编译时不被当成 test target），所以 `cargo test --lib` 仍靠
    // `.cargo/config.toml` 的 rustflags；这里真正兑住的是 `src-tauri/tests/*.rs` 这类
    // 集成测试目标（与 cwd 无关）。同理不能加 `/MANIFEST:EMBED`——bin 的 manifest 已由
    // tauri-build 作为资源写入，link 再内嵌会 CVT1100 duplicate resource。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' \
             version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
