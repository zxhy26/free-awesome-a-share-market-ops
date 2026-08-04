using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

#if BASIC_EDITION
[assembly: AssemblyTitle("Free & Awesome A-Share Market Ops - Basic")]
[assembly: AssemblyProduct("Free & Awesome A-Share Market Ops")]
[assembly: AssemblyDescription("A-share market review edition with quantitative stock selection and no activation-code issuer")]
#elif SELF_EDITION
[assembly: AssemblyTitle("Free & Awesome A-Share Market Ops - Personal Pro")]
[assembly: AssemblyProduct("Free & Awesome A-Share Market Ops")]
[assembly: AssemblyDescription("Personal A-share market review edition with quantitative stock selection")]
#elif CUSTOM_EDITION
[assembly: AssemblyTitle("A-Share Review - Custom Shortline")]
[assembly: AssemblyProduct("A-Share Review")]
[assembly: AssemblyDescription("Custom A-share market review edition with quantitative and shortline models")]
#else
[assembly: AssemblyTitle("Free & Awesome A-Share Market Ops")]
[assembly: AssemblyProduct("Free & Awesome A-Share Market Ops")]
[assembly: AssemblyDescription("Open-source desktop application for A-share market monitoring and review")]
#endif
[assembly: AssemblyCompany("Free & Awesome A-Share Market Ops")]
[assembly: AssemblyCopyright("Copyright 2026")]
[assembly: AssemblyVersion("2.21.5.0")]
[assembly: AssemblyFileVersion("2.21.5.0")]

internal static class Program
{
#if BASIC_EDITION
    private const string EditionName = "基础版";
    private const string EditionCode = "basic";
    private const string ReleaseEditionCode = "basic";
    private const string CanonicalLauncherName = "复盘软件基础版.exe";
    private const string RuntimeTag = "版本_20260804-2.21.5-基础版-跨平台";
    private const string MutexName = "Local\\AshareReviewLauncher_Basic_22150";
#elif SELF_EDITION
    private const string EditionName = "自用版";
    private const string EditionCode = "self";
    private const string ReleaseEditionCode = "self";
    private const string CanonicalLauncherName = "复盘软件自用版.exe";
    private const string RuntimeTag = "版本_20260804-2.21.5-自用版-跨平台";
    private const string MutexName = "Local\\AshareReviewLauncher_Self_22150";
#elif CUSTOM_EDITION
    private const string EditionName = "定制版";
    private const string EditionCode = "basic";
    private const string ReleaseEditionCode = "custom";
    private const string CanonicalLauncherName = "复盘软件定制版-短线模型V1.0.exe";
    private const string RuntimeTag = "版本_20260804-2.21.5-定制版-跨平台";
    private const string MutexName = "Local\\AshareReviewLauncher_Custom_22150";
#else
    private const string EditionName = "会员版";
    private const string EditionCode = "member";
    private const string ReleaseEditionCode = "member";
    private const string CanonicalLauncherName = "大a后勤部.exe";
    private const string RuntimeTag = "版本_自动更新-会员版";
    private const string MutexName = "Local\\AshareReviewLauncher_Member_22150";
#endif
    private const string LauncherVersion = "2.21.5";
#if CUSTOM_EDITION
    private const string UpdateManifestUrl = "https://raw.githubusercontent.com/zxhy26/free-awesome-a-share-market-ops/main/updates/custom.json";
#else
    private const string UpdateManifestUrl = "https://raw.githubusercontent.com/zxhy26/free-awesome-a-share-market-ops/main/updates/member.json";
#endif
    private const string PayloadResource = "AshareReviewPayload";
    private const string HashResource = "AshareReviewPayloadHash";
    private const string InnerExecutable = "A股复盘Windows版.exe";

    [STAThread]
    private static void Main()
    {
        bool testOnly = string.Equals(
            Environment.GetEnvironmentVariable("A_SHARE_REVIEW_LAUNCHER_TEST_ONLY"),
            "1",
            StringComparison.Ordinal
        );
        string resultPath = Environment.GetEnvironmentVariable("A_SHARE_REVIEW_LAUNCHER_TEST_RESULT") ?? "";
        bool createdNew;
        using (Mutex mutex = new Mutex(false, MutexName, out createdNew))
        {
            bool acquired = false;
            try
            {
                acquired = mutex.WaitOne(TimeSpan.FromSeconds(45));
                if (!acquired) throw new InvalidOperationException("另一个启动任务仍在释放运行文件，请稍后再试。");

                string expectedHash = ReadHashResource();
                string runtimeRoot = ResolveRuntimeRoot();
                EnsurePayload(runtimeRoot, expectedHash);
                string innerPath = Path.Combine(runtimeRoot, InnerExecutable);
                if (!File.Exists(innerPath)) throw new FileNotFoundException("复盘程序入口缺失。", innerPath);
                WriteLauncherMetadata(runtimeRoot, expectedHash, 0);

                if (testOnly)
                {
                    WriteTestResult(resultPath, true, runtimeRoot, expectedHash, "载荷释放验证通过");
                    return;
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = innerPath;
                startInfo.WorkingDirectory = runtimeRoot;
                startInfo.UseShellExecute = true;
                Environment.SetEnvironmentVariable("A_SHARE_REVIEW_EDITION", EditionCode);
                Environment.SetEnvironmentVariable("A_SHARE_REVIEW_RELEASE_EDITION", ReleaseEditionCode);
                Environment.SetEnvironmentVariable("A_SHARE_REVIEW_LAUNCHER_VERSION", LauncherVersion);
                Environment.SetEnvironmentVariable("A_SHARE_REVIEW_UPDATE_MANIFEST_URL", UpdateManifestUrl);
                Process innerProcess = Process.Start(startInfo);
                WriteLauncherMetadata(runtimeRoot, expectedHash, innerProcess == null ? 0 : innerProcess.Id);
            }
            catch (Exception error)
            {
                Environment.ExitCode = 1;
                if (testOnly)
                {
                    WriteTestResult(resultPath, false, "", "", error.Message);
                    return;
                }
                MessageBox.Show(
                    "复盘软件启动失败：\r\n" + error.Message,
                    "复盘软件" + EditionName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                if (acquired) mutex.ReleaseMutex();
            }
        }
    }

    private static string ResolveRuntimeRoot()
    {
        string testRoot = Environment.GetEnvironmentVariable("A_SHARE_REVIEW_LAUNCHER_TEST_ROOT") ?? "";
        string baseRoot = string.IsNullOrWhiteSpace(testRoot)
            ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            : Path.GetFullPath(testRoot);
        return Path.Combine(baseRoot, "A股复盘软件运行文件", EditionName, RuntimeTag);
    }

    private static string ReadHashResource()
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(HashResource))
        {
            if (stream == null) throw new InvalidOperationException("载荷校验资源缺失。");
            using (StreamReader reader = new StreamReader(stream, Encoding.ASCII))
            {
                string value = reader.ReadToEnd().Trim().ToUpperInvariant();
                if (value.Length != 64) throw new InvalidOperationException("载荷校验值无效。");
                return value;
            }
        }
    }

    private static void WriteLauncherMetadata(string runtimeRoot, string payloadHash, int appPid)
    {
        string metadataPath = Path.Combine(runtimeRoot, ".launcher.json");
        string temporaryPath = metadataPath + "." + Process.GetCurrentProcess().Id.ToString() + ".tmp";
        string json = "{"
            + "\"schemaVersion\":1,"
            + "\"product\":\"大a后勤部\","
            + "\"edition\":\"" + JsonEscape(EditionCode) + "\","
            + "\"releaseEdition\":\"" + JsonEscape(ReleaseEditionCode) + "\","
            + "\"version\":\"" + JsonEscape(LauncherVersion) + "\","
            + "\"launcherPath\":\"" + JsonEscape(Assembly.GetExecutingAssembly().Location) + "\","
            + "\"canonicalLauncherName\":\"" + JsonEscape(CanonicalLauncherName) + "\","
            + "\"runtimeRoot\":\"" + JsonEscape(runtimeRoot) + "\","
            + "\"payloadSha256\":\"" + JsonEscape(payloadHash) + "\","
            + "\"manifestUrl\":\"" + JsonEscape(UpdateManifestUrl) + "\","
            + "\"appPid\":" + appPid.ToString() + ","
            + "\"writtenAt\":\"" + DateTime.UtcNow.ToString("o") + "\""
            + "}";
        File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));
        if (File.Exists(metadataPath)) File.Delete(metadataPath);
        File.Move(temporaryPath, metadataPath);
    }

    private static void EnsurePayload(string runtimeRoot, string expectedHash)
    {
        string markerPath = Path.Combine(runtimeRoot, ".payload.sha256");
        if (File.Exists(Path.Combine(runtimeRoot, InnerExecutable))
            && File.Exists(markerPath)
            && string.Equals(File.ReadAllText(markerPath).Trim(), expectedHash, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        string parent = Path.GetDirectoryName(runtimeRoot);
        if (string.IsNullOrEmpty(parent)) throw new InvalidOperationException("运行目录无效。");
        Directory.CreateDirectory(parent);
        string temporaryRoot = Path.Combine(parent, ".AshareExtract-" + Guid.NewGuid().ToString("N"));
        string temporaryZip = Path.Combine(Path.GetTempPath(), "AshareReviewPayload-" + Guid.NewGuid().ToString("N") + ".zip");

        try
        {
            CopyAndVerifyPayload(temporaryZip, expectedHash);
            Directory.CreateDirectory(temporaryRoot);
            ExtractPayload(temporaryZip, temporaryRoot);
            if (!File.Exists(Path.Combine(temporaryRoot, InnerExecutable)))
            {
                throw new InvalidDataException("载荷中找不到复盘程序入口。");
            }
            File.WriteAllText(Path.Combine(temporaryRoot, ".payload.sha256"), expectedHash, Encoding.ASCII);

            string historyCachePath = Path.Combine("\u7f13\u5b58", "A\u80a1\u590d\u76d8\u5386\u53f2\u5e93.json");
            bool payloadHasHistoryCache = File.Exists(Path.Combine(temporaryRoot, historyCachePath));
            foreach (string preservedRoot in FindLegacyRuntimeRoots(parent, runtimeRoot))
            {
                MergePreservedDirectory(preservedRoot, temporaryRoot, "\u6570\u636e\u5386\u53f2");
                if (!payloadHasHistoryCache)
                {
                    MergePreservedFile(preservedRoot, temporaryRoot, historyCachePath, true);
                }
            }

            if (Directory.Exists(runtimeRoot))
            {
                string safeParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                string safeRuntime = Path.GetFullPath(runtimeRoot);
                if (!safeRuntime.StartsWith(safeParent, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("拒绝清理运行目录之外的路径。");
                }
                Directory.Delete(runtimeRoot, true);
            }
            Directory.Move(temporaryRoot, runtimeRoot);
        }
        finally
        {
            TryDeleteFile(temporaryZip);
            TryDeleteDirectory(temporaryRoot);
        }
    }

    private static List<string> FindLegacyRuntimeRoots(string parent, string currentRoot)
    {
        List<string> roots = new List<string>();
        try
        {
            string current = Path.GetFullPath(currentRoot).TrimEnd(Path.DirectorySeparatorChar);
            foreach (string candidate in Directory.GetDirectories(parent, "\u7248\u672c_*", SearchOption.TopDirectoryOnly))
            {
                string fullCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
                bool hasHistory = Directory.Exists(Path.Combine(candidate, "\u6570\u636e\u5386\u53f2"));
                bool hasHistoryCache = File.Exists(Path.Combine(candidate, "\u7f13\u5b58", "A\u80a1\u590d\u76d8\u5386\u53f2\u5e93.json"));
                if (!hasHistory && !hasHistoryCache) continue;
                if (!roots.Exists(delegate(string item) {
                    return string.Equals(Path.GetFullPath(item).TrimEnd(Path.DirectorySeparatorChar), fullCandidate, StringComparison.OrdinalIgnoreCase);
                })) roots.Add(candidate);
            }
            if (Directory.Exists(current) && !roots.Exists(delegate(string item) {
                return string.Equals(Path.GetFullPath(item).TrimEnd(Path.DirectorySeparatorChar), current, StringComparison.OrdinalIgnoreCase);
            })) roots.Add(current);
            roots.Sort(delegate(string left, string right) {
                return Directory.GetLastWriteTimeUtc(left).CompareTo(Directory.GetLastWriteTimeUtc(right));
            });
        }
        catch
        {
            return roots;
        }
        return roots;
    }

    private static void MergePreservedDirectory(string oldRoot, string newRoot, string relativePath)
    {
        string sourceRoot = Path.Combine(oldRoot, relativePath);
        if (!Directory.Exists(sourceRoot)) return;
        string destinationRoot = Path.Combine(newRoot, relativePath);
        Directory.CreateDirectory(destinationRoot);

        foreach (string sourceDirectory in Directory.GetDirectories(sourceRoot, "*", SearchOption.AllDirectories))
        {
            string relativeDirectory = sourceDirectory.Substring(sourceRoot.Length).TrimStart(Path.DirectorySeparatorChar);
            Directory.CreateDirectory(Path.Combine(destinationRoot, relativeDirectory));
        }
        foreach (string sourceFile in Directory.GetFiles(sourceRoot, "*", SearchOption.AllDirectories))
        {
            string relativeFile = sourceFile.Substring(sourceRoot.Length).TrimStart(Path.DirectorySeparatorChar);
            string destinationFile = Path.Combine(destinationRoot, relativeFile);
            string destinationDirectory = Path.GetDirectoryName(destinationFile);
            if (!string.IsNullOrEmpty(destinationDirectory)) Directory.CreateDirectory(destinationDirectory);
            bool userSettings = string.Equals(relativeFile, "\u7528\u6237\u8bbe\u7f6e.json", StringComparison.OrdinalIgnoreCase);
            if (!File.Exists(destinationFile) || userSettings) File.Copy(sourceFile, destinationFile, true);
        }
    }

    private static void MergePreservedFile(string oldRoot, string newRoot, string relativePath, bool replaceExisting)
    {
        string sourceFile = Path.Combine(oldRoot, relativePath);
        if (!File.Exists(sourceFile)) return;
        string destinationFile = Path.Combine(newRoot, relativePath);
        if (File.Exists(destinationFile) && !replaceExisting) return;
        string destinationDirectory = Path.GetDirectoryName(destinationFile);
        if (!string.IsNullOrEmpty(destinationDirectory)) Directory.CreateDirectory(destinationDirectory);
        File.Copy(sourceFile, destinationFile, true);
    }

    private static void CopyAndVerifyPayload(string targetZip, string expectedHash)
    {
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource))
        {
            if (source == null) throw new InvalidOperationException("内置运行载荷缺失。");
            using (FileStream destination = new FileStream(targetZip, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (SHA256 sha256 = SHA256.Create())
            using (CryptoStream hashingStream = new CryptoStream(destination, sha256, CryptoStreamMode.Write))
            {
                source.CopyTo(hashingStream);
                hashingStream.FlushFinalBlock();
                string actualHash = ToHex(sha256.Hash);
                if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("内置运行载荷校验失败。");
                }
            }
        }
    }

    private static void ExtractPayload(string zipPath, string targetRoot)
    {
        string root = Path.GetFullPath(targetRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (ZipArchive archive = ZipFile.OpenRead(zipPath))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                if (string.IsNullOrWhiteSpace(relative)) continue;
                string targetPath = Path.GetFullPath(Path.Combine(targetRoot, relative));
                if (!targetPath.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("载荷包含越界路径。");
                }
                bool isDirectory = string.IsNullOrEmpty(entry.Name)
                    || entry.FullName.EndsWith("/", StringComparison.Ordinal)
                    || entry.FullName.EndsWith("\\", StringComparison.Ordinal);
                if (isDirectory)
                {
                    Directory.CreateDirectory(targetPath);
                    continue;
                }
                string directory = Path.GetDirectoryName(targetPath);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                using (Stream source = entry.Open())
                using (FileStream destination = new FileStream(targetPath, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    source.CopyTo(destination);
                }
                if (entry.LastWriteTime.Year >= 1980)
                {
                    File.SetLastWriteTime(targetPath, entry.LastWriteTime.LocalDateTime);
                }
            }
        }
    }

    private static void WriteTestResult(string resultPath, bool ok, string runtimeRoot, string hash, string message)
    {
        if (string.IsNullOrWhiteSpace(resultPath)) return;
        string directory = Path.GetDirectoryName(Path.GetFullPath(resultPath));
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        int fileCount = Directory.Exists(runtimeRoot) ? Directory.GetFiles(runtimeRoot, "*", SearchOption.AllDirectories).Length : 0;
        string json = "{"
            + "\"ok\":" + (ok ? "true" : "false") + ","
            + "\"edition\":\"" + JsonEscape(EditionName) + "\","
            + "\"runtimeRoot\":\"" + JsonEscape(runtimeRoot) + "\","
            + "\"payloadSha256\":\"" + JsonEscape(hash) + "\","
            + "\"innerExecutable\":\"" + JsonEscape(string.IsNullOrEmpty(runtimeRoot) ? "" : Path.Combine(runtimeRoot, InnerExecutable)) + "\","
            + "\"fileCount\":" + fileCount.ToString() + ","
            + "\"message\":\"" + JsonEscape(message) + "\""
            + "}";
        File.WriteAllText(resultPath, json, new UTF8Encoding(false));
    }

    private static string JsonEscape(string value)
    {
        return (value ?? "")
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n");
    }

    private static string ToHex(byte[] bytes)
    {
        StringBuilder builder = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes) builder.Append(value.ToString("X2"));
        return builder.ToString();
    }

    private static void TryDeleteFile(string filePath)
    {
        try
        {
            if (File.Exists(filePath)) File.Delete(filePath);
        }
        catch
        {
        }
    }

    private static void TryDeleteDirectory(string directoryPath)
    {
        try
        {
            if (Directory.Exists(directoryPath)) Directory.Delete(directoryPath, true);
        }
        catch
        {
        }
    }
}
