using DSHNotch;

namespace DSHNotch.Tests;

public sealed class CredentialTests
{
    private const string Sample = """
        # DSH 凭据（测试样本）
        other-platform/default:
          token: should-not-be-picked
          issuer: https://example.com
        deepseek-account-platform/default:
          token: "abc.def.ghi"
          issuer: https://platform.deepseek.com
          token_estimation: 100
        unrelated: value
        """;

    [Fact]
    public void Parse_ReadsTokenAndIssuer()
    {
        var credential = DSHCredentials.Parse(Sample);

        Assert.Equal("abc.def.ghi", credential.Token);
        Assert.Equal("https://platform.deepseek.com/", credential.Issuer.ToString());
    }

    [Fact]
    public void Parse_ThrowsRecordMissing_WhenRecordAbsent()
    {
        var text = """
            other-platform/default:
              token: x
              issuer: https://example.com
            """;

        var error = Assert.Throws<CredentialException>(() => DSHCredentials.Parse(text));

        Assert.Equal(CredentialErrorKind.RecordMissing, error.Kind);
    }

    [Fact]
    public void Parse_ThrowsFieldMissing_WhenTokenAbsent()
    {
        var text = """
            deepseek-account-platform/default:
              issuer: https://platform.deepseek.com
            """;

        var error = Assert.Throws<CredentialException>(() => DSHCredentials.Parse(text));

        Assert.Equal(CredentialErrorKind.FieldMissing, error.Kind);
        Assert.Contains("token", error.Message);
    }

    [Fact]
    public void Parse_ThrowsFieldMissing_WhenTokenEmpty()
    {
        var text = """
            deepseek-account-platform/default:
              token: ""
              issuer: https://platform.deepseek.com
            """;

        var error = Assert.Throws<CredentialException>(() => DSHCredentials.Parse(text));

        Assert.Equal(CredentialErrorKind.FieldMissing, error.Kind);
    }

    [Theory]
    [InlineData("ftp://platform.deepseek.com")]
    [InlineData("http://platform.deepseek.com")]
    [InlineData("not a url")]
    public void Parse_ThrowsBadIssuer_WhenIssuerInvalid(string issuer)
    {
        var text = "deepseek-account-platform/default:\n  token: abc\n  issuer: " + issuer + "\n";

        var error = Assert.Throws<CredentialException>(() => DSHCredentials.Parse(text));

        Assert.Equal(CredentialErrorKind.BadIssuer, error.Kind);
    }

    [Fact]
    public void Parse_StopsAtSameIndentRecord()
    {
        // token 在下一个同级记录下，不能被抓进 deepseek 记录。
        var text = """
            deepseek-account-platform/default:
              issuer: https://platform.deepseek.com
            next-record:
              token: wrong
            """;

        var error = Assert.Throws<CredentialException>(() => DSHCredentials.Parse(text));

        Assert.Equal(CredentialErrorKind.FieldMissing, error.Kind);
    }

    [Fact]
    public void Parse_HandlesCrlfAndTabIndent()
    {
        var text = "deepseek-account-platform/default:\r\n\ttoken: abc\r\n\tissuer: https://platform.deepseek.com\r\n";

        var credential = DSHCredentials.Parse(text);

        Assert.Equal("abc", credential.Token);
    }

    [Fact]
    public void Load_ThrowsFileMissing_WhenFileAbsent()
    {
        var home = Path.Combine(Path.GetTempPath(), "dshnotch-cred-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(home);
        try
        {
            var error = Assert.Throws<CredentialException>(() => DSHCredentials.Load(home));
            Assert.Equal(CredentialErrorKind.FileMissing, error.Kind);
        }
        finally
        {
            Directory.Delete(home, recursive: true);
        }
    }

    [Fact]
    public void Load_ReadsFromHomeDirectory()
    {
        var home = Path.Combine(Path.GetTempPath(), "dshnotch-cred-" + Guid.NewGuid().ToString("N"));
        var dsh = Path.Combine(home, ".dsh");
        Directory.CreateDirectory(dsh);
        try
        {
            File.WriteAllText(Path.Combine(dsh, ".credentials.yaml"), Sample);
            var credential = DSHCredentials.Load(home);
            Assert.Equal("abc.def.ghi", credential.Token);
        }
        finally
        {
            Directory.Delete(home, recursive: true);
        }
    }
}
