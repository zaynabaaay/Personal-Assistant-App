import { ActivityIndicator, StyleSheet, View } from 'react-native';

export default function AuthLoadingScreen() {
  return (
    <View style={styles.container}>
      <ActivityIndicator color="#8B8983" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#F5F4F0',
    flex: 1,
    justifyContent: 'center',
  },
});
