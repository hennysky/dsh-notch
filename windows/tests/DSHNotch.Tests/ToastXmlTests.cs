using System.Xml;
using DSHNotch;

namespace DSHNotch.Tests;

public sealed class ToastXmlTests
{
    [Fact]
    public void Escape_HandlesXmlSpecialCharacters()
    {
        Assert.Equal("a&lt;b&gt;&amp;&quot;&apos;", ToastXml.Escape("a<b>&\"'"));
    }

    [Fact]
    public void Escape_StripsInvalidXmlControlCharacters()
    {
        Assert.Equal("ab", ToastXml.Escape("a\u0001b"));
        Assert.Equal("a\tb\nc\rd", ToastXml.Escape("a\tb\nc\rd"));
    }

    [Fact]
    public void Escape_KeepsChineseAndEmoji()
    {
        Assert.Equal("任务完成 🎉", ToastXml.Escape("任务完成 🎉"));
    }

    [Fact]
    public void Build_IsValidXmlWithProtocolActivation()
    {
        var xml = ToastXml.Build("任务 <完成> & \"好\"", "正文 > 500 & <tag>");

        var document = new XmlDocument();
        document.LoadXml(xml);

        var toast = document.DocumentElement!;
        Assert.Equal("toast", toast.Name);
        Assert.Equal("protocol", toast.GetAttribute("activationType"));
        Assert.Equal("dshnotch://open-dsh", toast.GetAttribute("launch"));

        var texts = toast.GetElementsByTagName("text");
        Assert.Equal(2, texts.Count);
        Assert.Equal("任务 <完成> & \"好\"", texts[0]!.InnerText);
        Assert.Equal("正文 > 500 & <tag>", texts[1]!.InnerText);
    }

    [Fact]
    public void Build_EscapesNewlinesButKeepsThem()
    {
        var xml = ToastXml.Build("标题", "第一行\n第二行");

        var document = new XmlDocument();
        document.LoadXml(xml);

        Assert.Contains("第一行\n第二行", document.DocumentElement!.InnerText);
    }

    [Fact]
    public void Build_EmptyTextsAreStillValid()
    {
        var xml = ToastXml.Build(string.Empty, string.Empty);

        var document = new XmlDocument();
        document.LoadXml(xml);

        var texts = document.DocumentElement!.GetElementsByTagName("text");
        Assert.Equal(2, texts.Count);
        Assert.Equal(string.Empty, texts[0]!.InnerText);
    }
}
