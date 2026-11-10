namespace Lab;

public static class Entry
{
    public static string FromNumber() => Converter.Select(7);
    public static string FromText() { var label = "甲😀"; return Converter.Select(label); }
}
