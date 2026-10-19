#!/usr/bin/env python3
"""创建或复用 Sirius 专用签名钥匙串，使重复构建无需个人钥匙串密码。"""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import tempfile

COMMON_NAME = "Sirius Local Development"
BUNDLE_IDENTIFIER = "com.sirius.desktop"
SIGNING_DIRECTORY = Path.home() / "Library/Application Support/com.sirius.desktop/signing"
IDENTITY_PATH = SIGNING_DIRECTORY / "identity.json"
CERTIFICATE_PATH = SIGNING_DIRECTORY / "certificate.pem"
KEYCHAIN_PATH = SIGNING_DIRECTORY / "sirius-local-signing.keychain-db"
PASSWORD_PATH = SIGNING_DIRECTORY / "keychain-password"


def run(command, *, timeout=None):
    """执行系统工具并返回文本；失败保留诊断，不回显含随机密码的参数。"""
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{Path(command[0]).name} {command[1]} 等待系统操作超时") from None
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"{Path(command[0]).name} {command[1]} 失败（{result.returncode}）：{message}")
    return result.stdout


def require_private_path(path, *, directory=False):
    """验证路径由当前用户独占；拒绝符号链接和其它用户可访问的权限。"""
    metadata = path.lstat()
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected_type(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise RuntimeError(f"本机签名路径类型或所有者异常：{path}")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise RuntimeError(f"本机签名路径允许其它用户访问，请先收紧权限：{path}")


def fingerprint(certificate, algorithm):
    """返回公开证书指纹；algorithm 由脚本指定为 sha1 或 sha256。"""
    output = run(["/usr/bin/openssl", "x509", "-in", str(certificate), "-noout", "-fingerprint", f"-{algorithm}"])
    value = output.partition("=")[2].strip().replace(":", "").upper()
    expected_length = {"sha1": 40, "sha256": 64}[algorithm]
    if not re.fullmatch(rf"[0-9A-F]{{{expected_length}}}", value):
        raise RuntimeError("系统工具返回了无效的公开证书指纹")
    return value


def matching_identity(certificate_sha1, *, valid_only):
    """只查询专用库中的指定身份；valid_only 为真时要求代码签名信任有效。"""
    arguments = ["/usr/bin/security", "find-identity"]
    if valid_only:
        arguments.append("-v")
    output = run(arguments + ["-p", "codesigning", str(KEYCHAIN_PATH)])
    return re.search(rf"\b{re.escape(certificate_sha1)}\b", output, re.IGNORECASE) is not None


def remove_from_search_list():
    """移除新建专用库的搜索项并保留其它项；签名始终显式指定专用库。"""
    paths = shlex.split(run(["/usr/bin/security", "list-keychains", "-d", "user"]))
    retained = [path for path in paths if Path(path) != KEYCHAIN_PATH]
    if retained != paths:
        run(["/usr/bin/security", "list-keychains", "-d", "user", "-s", *retained])


def add_to_search_list():
    """让签名工具在构建期间可发现专用身份；返回是否由本次调用新增搜索项。"""
    paths = shlex.split(run(["/usr/bin/security", "list-keychains", "-d", "user"]))
    if str(KEYCHAIN_PATH) in paths:
        return False
    # 本机 codesign 解析私钥时仍依赖搜索列表，即便传入了 --keychain 也必须临时加入。
    run(["/usr/bin/security", "list-keychains", "-d", "user", "-s", *paths, str(KEYCHAIN_PATH)])
    return True


def cleanup_keychain(remove_search_item):
    """清理本次新增搜索项并锁回专用库；两个动作都尝试，任一失败均明确报告。"""
    failures = []
    if remove_search_item:
        try:
            remove_from_search_list()
        except (RuntimeError, OSError) as error:
            failures.append(str(error))
    try:
        run(["/usr/bin/security", "lock-keychain", str(KEYCHAIN_PATH)])
    except (RuntimeError, OSError) as error:
        failures.append(str(error))
    if failures:
        raise RuntimeError("清理专用签名库失败：" + "；".join(failures))


def create_identity(password):
    """创建十年期专用身份；导入后清理临时加密材料，私钥长期只留在专用钥匙串。"""
    with tempfile.TemporaryDirectory(prefix="sirius-signing-") as temporary:
        directory = Path(temporary)
        config = directory / "certificate.cnf"
        config.write_text("""[req]
prompt = no
distinguished_name = subject
x509_extensions = codesign
[subject]
CN = Sirius Local Development
[codesign]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
""")
        password_file = directory / "import-password"
        # OpenSSL 从同一文件读取 passin/passout 时会依次读取两行。
        password_file.write_text(password + "\n" + password + "\n")
        private_key, certificate, archive = (directory / name for name in ("private.pem", "certificate.pem", "identity.p12"))
        run(["/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:3072", "-sha256", "-days", "3650", "-config", str(config), "-keyout", str(private_key), "-out", str(certificate), "-passout", f"file:{password_file}"])
        run(["/usr/bin/openssl", "pkcs12", "-export", "-inkey", str(private_key), "-in", str(certificate), "-name", COMMON_NAME, "-out", str(archive), "-passin", f"file:{password_file}", "-passout", f"file:{password_file}", "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES"])
        # 此随机密码只解锁构建专用库，与 Mac 登录、115 和 AI 密钥均无关。
        with PASSWORD_PATH.open("x") as target:
            target.write(password + "\n")
        run(["/usr/bin/security", "create-keychain", "-p", password, str(KEYCHAIN_PATH)])
        remove_from_search_list()
        run(["/usr/bin/security", "set-keychain-settings", "-l", "-u", "-t", "300", str(KEYCHAIN_PATH)])
        run(["/usr/bin/security", "unlock-keychain", "-p", password, str(KEYCHAIN_PATH)])
        run(["/usr/bin/security", "import", str(archive), "-k", str(KEYCHAIN_PATH), "-f", "pkcs12", "-P", password, "-x", "-T", "/usr/bin/codesign"])
        # 只配置新建专用库的 Apple 签名工具分区，不修改个人钥匙串中任何密钥的权限。
        run(["/usr/bin/security", "set-key-partition-list", "-S", "apple:", "-s", "-k", password, str(KEYCHAIN_PATH)])
        CERTIFICATE_PATH.write_text(certificate.read_text())


def verify_signing(certificate_sha1):
    """签署并严格验证临时二进制，确认构建进程真实可用私钥，而非只找到公开证书。"""
    with tempfile.TemporaryDirectory(prefix="sirius-signing-probe-") as temporary:
        target = Path(temporary) / "probe"
        # copy2 会复制系统二进制的受保护标志；只复制内容，避免把该标志带入临时副本。
        shutil.copyfile("/usr/bin/true", target)
        target.chmod(0o700)
        requirement = f'=designated => identifier "{BUNDLE_IDENTIFIER}.signing-probe" and certificate leaf = H"{certificate_sha1}"'
        run(["/usr/bin/codesign", "--force", "--sign", certificate_sha1, "--keychain", str(KEYCHAIN_PATH), "--timestamp=none", "--requirements", requirement, str(target)], timeout=20)
        run(["/usr/bin/codesign", "--verify", "--strict", str(target)], timeout=20)


def main():
    """复用固定专用身份，完成首次证书信任和真实签名验证后保存公开身份元数据。"""
    os.umask(0o077)
    SIGNING_DIRECTORY.mkdir(parents=True, exist_ok=True, mode=0o700)
    require_private_path(SIGNING_DIRECTORY, directory=True)
    if not KEYCHAIN_PATH.exists():
        if IDENTITY_PATH.exists() or PASSWORD_PATH.exists() or CERTIFICATE_PATH.exists():
            raise RuntimeError("已有签名材料但专用钥匙串丢失，未自动生成替代身份")
        try:
            create_identity(secrets.token_urlsafe(48))
        finally:
            if KEYCHAIN_PATH.exists():
                cleanup_keychain(True)
    for path in (KEYCHAIN_PATH, PASSWORD_PATH, CERTIFICATE_PATH):
        require_private_path(path)
    password = PASSWORD_PATH.read_text().strip()
    if not password:
        raise RuntimeError("专用签名钥匙串的解锁材料为空")
    run(["/usr/bin/security", "unlock-keychain", "-p", password, str(KEYCHAIN_PATH)])
    added_search_item = False
    operation_error = None
    try:
        added_search_item = add_to_search_list()
        identity = {"commonName": COMMON_NAME, "bundleIdentifier": BUNDLE_IDENTIFIER, "certificateSha1": fingerprint(CERTIFICATE_PATH, "sha1"), "certificateSha256": fingerprint(CERTIFICATE_PATH, "sha256"), "keychainPath": str(KEYCHAIN_PATH)}
        if IDENTITY_PATH.exists():
            require_private_path(IDENTITY_PATH)
            if json.loads(IDENTITY_PATH.read_text()) != identity:
                raise RuntimeError("固定签名身份与专用库不一致，未覆盖原有配置")
        if not matching_identity(identity["certificateSha1"], valid_only=False):
            raise RuntimeError("专用库中的证书或私钥丢失，未生成新身份")
        if not matching_identity(identity["certificateSha1"], valid_only=True):
            print("首次证书信任如需 macOS 验证，请手动完成；后续构建不请求个人钥匙串密码。", flush=True)
            run(["/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", str(KEYCHAIN_PATH), str(CERTIFICATE_PATH)])
        if not matching_identity(identity["certificateSha1"], valid_only=True):
            raise RuntimeError("专用证书的代码签名信任未通过")
        verify_signing(identity["certificateSha1"])
        if not IDENTITY_PATH.exists():
            with IDENTITY_PATH.open("x") as target:
                json.dump(identity, target, ensure_ascii=False, indent=2)
                target.write("\n")
        print(f"固定专用签名身份：{COMMON_NAME}")
        print(f"证书 SHA-256：{identity['certificateSha256']}")
        print("真实签名验证通过；后续构建自动解锁专用库并在签名后锁回。")
    except BaseException as error:
        operation_error = error
        raise
    finally:
        # 专用签名密钥仅在构建时解锁，不长期开放个人钥匙串。
        try:
            cleanup_keychain(added_search_item)
        except RuntimeError as cleanup_error:
            if operation_error is not None:
                raise RuntimeError(f"{operation_error}；{cleanup_error}") from None
            raise


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        raise SystemExit(f"设置本地签名失败：{error}") from None
