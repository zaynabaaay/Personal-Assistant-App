import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

export type ProjectSectionDefinition = {
  id: string;
  title: string;
};

export function ProjectSectionNavigation({
  onSelect,
  sections,
  selectedId,
}: {
  onSelect: (section: ProjectSectionDefinition) => void;
  sections: readonly ProjectSectionDefinition[];
  selectedId: string;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="project-section-navigation"
    >
      {sections.map((section) => {
        const selected = section.id === selectedId;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={section.id}
            onPress={() => onSelect(section)}
            style={[styles.item, selected && styles.itemSelected]}
          >
            <Text style={[styles.text, selected && styles.textSelected]}>{section.title}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20 },
  item: {
    borderBottomColor: 'transparent',
    borderBottomWidth: 2,
    justifyContent: 'center',
    marginRight: 22,
    minHeight: 44,
  },
  itemSelected: { borderBottomColor: '#D9D9DC' },
  text: { color: '#69696F', fontSize: 14, fontWeight: '500' },
  textSelected: { color: '#E9E9EB' },
});
