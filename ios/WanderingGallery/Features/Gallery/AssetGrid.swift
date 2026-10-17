import SwiftUI

/// Square thumbnails, optionally under day headers, loading more near the end.
struct AssetGrid: View {
    let items: [Asset]
    let density: GridDensity
    let groupByDay: Bool
    let onOpen: (Asset) -> Void
    let onNearEnd: () -> Void

    private var columns: [GridItem] { [GridItem(.adaptive(minimum: density.minWidth), spacing: 2)] }

    var body: some View {
        // The last ~60 items trigger the next page, like the web grid's look-ahead.
        let trigger = Set(items.suffix(60).map(\.id))
        LazyVGrid(columns: columns, alignment: .leading, spacing: 2, pinnedViews: groupByDay ? [.sectionHeaders] : []) {
            if groupByDay {
                ForEach(DayGrouping.sections(items, date: \.date), id: \.day) { section in
                    Section {
                        cells(section.items, trigger: trigger)
                    } header: {
                        Text(DayGrouping.title(section.day))
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(.bar)
                    }
                }
            } else {
                cells(items, trigger: trigger)
            }
        }
    }

    @ViewBuilder private func cells(_ items: [Asset], trigger: Set<Int>) -> some View {
        ForEach(items) { a in
            AssetCell(asset: a)
                .onTapGesture { onOpen(a) }
                .onAppear { if trigger.contains(a.id) { onNearEnd() } }
        }
    }
}

struct AssetCell: View {
    @Environment(AppModel.self) private var model
    let asset: Asset

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { RemoteImage(url: model.client.thumbURL(asset)) }
            .clipped()
            .overlay(alignment: .bottomLeading) { kindBadge }
            .overlay(alignment: .topTrailing) {
                if asset.favorite {
                    Image(systemName: "heart.fill").font(.system(size: 12)).foregroundStyle(Theme.favorite)
                        .shadow(radius: 2).padding(5)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if asset.rating > 0 {
                    HStack(spacing: 1) {
                        Image(systemName: "star.fill").font(.system(size: 8))
                        Text("\(asset.rating)").font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(Theme.star)
                    .padding(.horizontal, 4).padding(.vertical, 2)
                    .background(.black.opacity(0.55), in: Capsule())
                    .padding(4)
                }
            }
            .overlay(alignment: .topLeading) {
                HStack(spacing: 4) {
                    if asset.hidden || asset.libraryHidden {
                        Image(systemName: "eye.slash.fill").font(.system(size: 11)).foregroundStyle(.white)
                            .padding(3).background(.black.opacity(0.55), in: Circle())
                    }
                    if let c = asset.caption {
                        Circle().fill(Theme.caption(c)).frame(width: 9, height: 9)
                            .overlay { if asset.captionCandidate { Circle().stroke(.white, lineWidth: 1.5) } }
                    }
                }
                .padding(5)
            }
            .contentShape(Rectangle())
            .accessibilityElement()
            .accessibilityLabel(asset.name)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("cell-\(asset.name)")
    }

    @ViewBuilder private var kindBadge: some View {
        let label: (String, String)? = switch asset.kind {
        case .video: ("play.fill", asset.duration.map(Format.duration) ?? "")
        case .audio: ("music.note", asset.duration.map(Format.duration) ?? "")
        case .markdown: ("doc.text", "MD")
        case .image: nil
        }
        if let (icon, text) = label {
            HStack(spacing: 3) {
                Image(systemName: icon).font(.system(size: 9))
                Text(text).font(.system(size: 10, weight: .semibold)).monospacedDigit()
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(.black.opacity(0.6), in: Capsule())
            .padding(4)
        }
    }
}
