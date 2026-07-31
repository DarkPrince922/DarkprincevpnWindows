using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;

namespace DarkPrinceVpn.Ui;

/// <summary>
/// Живой фон: несколько размытых пятен золотого и синего, медленно плывущих
/// по экрану. Тот же приём, что в мобильных версиях — интерфейс перестаёт
/// выглядеть плоским, при этом ничего не нагружает: анимируются четыре
/// фигуры, а не картинка.
/// </summary>
public sealed class AnimatedBackground : Grid
{
    private readonly record struct Blob(
        double X, double Y, double Size, Color Color, double Seconds);

    private static readonly Blob[] Blobs =
    {
        new(0.15, 0.10, 420, Color.FromRgb(0xCF, 0xAA, 0x62), 26),
        new(0.80, 0.25, 360, Color.FromRgb(0x5E, 0x8B, 0xFF), 34),
        new(0.25, 0.75, 380, Color.FromRgb(0xCF, 0xAA, 0x62), 30),
        new(0.85, 0.85, 300, Color.FromRgb(0x5E, 0x8B, 0xFF), 22),
    };

    public AnimatedBackground()
    {
        ClipToBounds = true;
        Background = new SolidColorBrush(Color.FromRgb(0x0A, 0x0E, 0x17));
        Loaded += (_, _) => Build();
    }

    private bool _built;

    private void Build()
    {
        if (_built) return;
        _built = true;

        foreach (var blob in Blobs)
        {
            var ellipse = new Ellipse
            {
                Width = blob.Size,
                Height = blob.Size,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
                IsHitTestVisible = false,
                Fill = new RadialGradientBrush
                {
                    GradientStops = new GradientStopCollection
                    {
                        new(Color.FromArgb(0x38, blob.Color.R, blob.Color.G, blob.Color.B), 0),
                        new(Color.FromArgb(0x00, blob.Color.R, blob.Color.G, blob.Color.B), 1),
                    },
                },
            };

            var transform = new TranslateTransform();
            ellipse.RenderTransform = transform;
            Children.Insert(0, ellipse);

            // положение задаём через отступ, а плавание — через сдвиг:
            // так пятно остаётся привязанным к своей четверти экрана
            ellipse.Margin = new Thickness(
                blob.X * 460 - blob.Size / 2,
                blob.Y * 700 - blob.Size / 2,
                0, 0);

            Animate(transform, TranslateTransform.XProperty, 34, blob.Seconds);
            Animate(transform, TranslateTransform.YProperty, 26, blob.Seconds * 1.3);
        }
    }

    private static void Animate(
        TranslateTransform transform,
        DependencyProperty property,
        double distance,
        double seconds)
    {
        var animation = new DoubleAnimation
        {
            From = -distance,
            To = distance,
            Duration = TimeSpan.FromSeconds(seconds),
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        };
        transform.BeginAnimation(property, animation);
    }
}
