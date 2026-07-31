using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace DarkPrinceVpn.Ui;

/// <summary>
/// Верхняя рамка окна по умолчанию светлая и выбивается из тёмного
/// оформления. Windows позволяет её перекрасить, но по-разному в зависимости
/// от версии:
///
/// * Windows 11 — можно задать точный цвет заголовка и рамки;
/// * Windows 10 (1809+) — только «тёмный режим», без выбора оттенка;
/// * более старые — никак, там оставляем как есть.
/// </summary>
public static class DarkTitleBar
{
    private const int UseImmersiveDarkMode = 20;
    private const int CaptionColor = 35;
    private const int BorderColor = 34;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>Красит рамку окна в цвет фона приложения.</summary>
    public static void Apply(Window window, Color color)
    {
        void Paint()
        {
            var handle = new WindowInteropHelper(window).Handle;
            if (handle == IntPtr.Zero) return;

            // тёмный режим включаем всегда: на Windows 10 это единственное,
            // что доступно, а на 11 он делает текст заголовка светлым
            var darkMode = 1;
            DwmSetWindowAttribute(handle, UseImmersiveDarkMode, ref darkMode, sizeof(int));

            // COLORREF: 0x00BBGGRR — порядок байтов обратный привычному
            var colorRef = color.R | (color.G << 8) | (color.B << 16);
            DwmSetWindowAttribute(handle, CaptionColor, ref colorRef, sizeof(int));
            DwmSetWindowAttribute(handle, BorderColor, ref colorRef, sizeof(int));
        }

        if (window.IsLoaded) Paint();
        else window.SourceInitialized += (_, _) => Paint();
    }
}
